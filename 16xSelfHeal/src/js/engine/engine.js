/**
 * 16x SelfHeal — Simulation engine (pure JS, no DOM).
 *
 * Models a microservice system as groups of node instances connected by edges.
 * Simulates: request routing (least-connections LB), health-check detection,
 * circuit breakers, retries, cache fallbacks, a Kubernetes-style orchestrator
 * that replaces dead instances, and database primary/replica failover.
 *
 * All time values are simulated milliseconds; `tick(dtMs)` advances the world.
 */

export const NodeState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  STARTING: 'starting',
  DEAD: 'dead',
};

let _id = 1;
export const uid = (p = 'n') => `${p}${_id++}`;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------------

export class Engine {
  constructor() { this.reset(); }

  reset() {
    this.nodes = new Map();     // id -> node
    this.edges = [];            // {id, from, to, cut, latencyAdded, breaker, results:[]}
    this.groups = new Map();    // id -> group
    this.groupLinks = [];       // {from: groupId, to: groupId}
    this.requests = [];         // live request particles
    this.events = [];
    this.time = 0;
    this.running = true;
    this.speed = 1;
    this.rps = 14;
    this.trafficMultiplier = 1;
    this._trafficTimer = 0;
    this.chaosMonkey = false;
    this._acc = { spawn: 0, health: 0, orch: 0, metric: 0, monkey: rand(5000, 9000) };
    this.stats = { total: 0, ok: 0, err: 0, fallback: 0, retried: 0 };
    this.buckets = [];          // per-second {t, ok, err, lat, inflight}
    this._bucket = { ok: 0, err: 0, latSum: 0, latN: 0 };
    this.incident = null;       // {start, cause}
    this.lastMTTR = null;
    this.incidents = [];        // history {start, end, cause, mttr}
    this.schedule = [];         // scenario actions [{at, fn, label}]
    this.listeners = {};
  }

  // -- events ---------------------------------------------------------------
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, d) { (this.listeners[ev] || []).forEach((f) => f(d)); }

  log(type, severity, msg) {
    const e = { t: this.time, type, severity, msg };
    this.events.push(e);
    if (this.events.length > 600) this.events.shift();
    this.emit('event', e);
  }

  // -- topology building ------------------------------------------------------
  /**
   * @param {object} spec {id?, name, type: client|lb|gateway|service|cache|db|queue,
   *   replicas, x, y, capacity, baseLatency, autoheal, cacheHitRate}
   */
  addGroup(spec) {
    const g = {
      id: spec.id || uid('g'),
      name: spec.name,
      type: spec.type,
      desired: spec.replicas ?? 1,
      x: spec.x, y: spec.y,
      capacity: spec.capacity ?? 25,
      baseLatency: spec.baseLatency ?? 40,
      autoheal: spec.autoheal ?? (spec.type !== 'client' && spec.type !== 'lb' ? true : false),
      cacheHitRate: spec.cacheHitRate ?? 0.7,
      bootTime: spec.bootTime ?? [2500, 5000],
      failoverTimer: null,
      nodeIds: [],
    };
    this.groups.set(g.id, g);
    for (let i = 0; i < g.desired; i++) {
      const role = g.type === 'db' ? (i === 0 ? 'primary' : 'replica') : null;
      this._spawnNode(g, role, NodeState.HEALTHY, 0, i);
    }
    return g;
  }

  _spawnNode(g, role, state, bootRemaining, slot = null) {
    const idx = slot ?? g.nodeIds.length;
    const n = {
      id: uid('n'),
      group: g.id,
      type: g.type,
      name: g.desired > 1 || g.type === 'db'
        ? `${g.name}-${String.fromCharCode(97 + (idx % 26))}${idx >= 26 ? idx : ''}`
        : g.name,
      role,
      x: g.x + (idx % 2 === 0 ? 0 : 14) + rand(-4, 4),
      y: g.y + idx * 64 + rand(-3, 3),
      state,
      inPool: state === NodeState.HEALTHY,
      inflight: 0,
      capacity: g.capacity,
      capFactor: 1,
      baseLatency: g.baseLatency,
      latencyBoost: 0,
      latencyBoostUntil: 0,
      healthFails: 0,
      bootRemaining,
      diedAt: null,
      spawnedAt: this.time,
      pulse: 0, // renderer hint
    };
    this.nodes.set(n.id, n);
    g.nodeIds.push(n.id);
    // wire edges according to group links
    for (const l of this.groupLinks) {
      if (l.from === g.id) for (const t of this.groups.get(l.to).nodeIds) this._addEdge(n.id, t);
      if (l.to === g.id) for (const f of this.groups.get(l.from).nodeIds) this._addEdge(f, n.id);
    }
    return n;
  }

  _addEdge(from, to) {
    if (from === to) return;
    if (this.edges.some((e) => e.from === from && e.to === to)) return;
    this.edges.push({
      id: uid('e'), from, to, cut: false, cutUntil: 0,
      latencyAdded: 0, breaker: 'closed', openedAt: 0, results: [],
    });
  }

  connectGroups(fromId, toId) {
    if (this.groupLinks.some((l) => l.from === fromId && l.to === toId)) return;
    this.groupLinks.push({ from: fromId, to: toId });
    const A = this.groups.get(fromId), B = this.groups.get(toId);
    for (const f of A.nodeIds) for (const t of B.nodeIds) this._addEdge(f, t);
  }

  removeGroup(gid) {
    const g = this.groups.get(gid);
    if (!g || g.type === 'client' || g.type === 'lb') return false;
    for (const nid of [...g.nodeIds]) this._removeNode(nid);
    this.groupLinks = this.groupLinks.filter((l) => l.from !== gid && l.to !== gid);
    this.groups.delete(gid);
    this.log('topology', 'info', `Service group "${g.name}" removed from topology`);
    return true;
  }

  _removeNode(nid) {
    const n = this.nodes.get(nid);
    if (!n) return;
    const g = this.groups.get(n.group);
    if (g) g.nodeIds = g.nodeIds.filter((x) => x !== nid);
    this.edges = this.edges.filter((e) => e.from !== nid && e.to !== nid);
    this.requests = this.requests.filter((r) => r.from !== nid && r.to !== nid);
    this.nodes.delete(nid);
  }

  setDesired(gid, count) {
    const g = this.groups.get(gid);
    if (!g) return;
    count = Math.max(1, Math.min(8, count));
    g.desired = count;
    this.log('topology', 'info', `Scaling "${g.name}" — desired replicas set to ${count}`);
    // scale down immediately if above desired
    while (this._aliveNodes(g).length > count) {
      const victim = this._aliveNodes(g).slice(-1)[0];
      this.log('orchestrator', 'info', `Scaling down: terminating ${victim.name}`);
      this._removeNode(victim.id);
    }
  }

  groupByName(name) {
    const q = name.toLowerCase();
    for (const g of this.groups.values()) if (g.name.toLowerCase() === q) return g;
    for (const g of this.groups.values()) if (g.name.toLowerCase().includes(q)) return g;
    return null;
  }

  _aliveNodes(g) {
    return g.nodeIds.map((id) => this.nodes.get(id))
      .filter((n) => n && n.state !== NodeState.DEAD);
  }

  // -- routing plans ----------------------------------------------------------
  /** Downstream group ids reachable from group gid. */
  _downstream(gid) { return this.groupLinks.filter((l) => l.from === gid).map((l) => l.to); }

  /**
   * Build a linear visit plan for one request:
   * client → lb → [gateway] → service → [cache] → [db/queue...]
   */
  _buildPlan() {
    const client = [...this.groups.values()].find((g) => g.type === 'client');
    if (!client) return null;
    const plan = [];
    let cur = client.id;
    // walk lb / gateway spine
    for (let depth = 0; depth < 6; depth++) {
      const outs = this._downstream(cur);
      if (!outs.length) break;
      const outGroups = outs.map((id) => this.groups.get(id));
      const spine = outGroups.find((g) => g.type === 'lb' || g.type === 'gateway');
      if (spine && depth < 2) { plan.push({ group: spine.id }); cur = spine.id; continue; }
      // pick a business service at random (weighted equally)
      const svcs = outGroups.filter((g) => g.type === 'service');
      const target = svcs.length ? pick(svcs) : pick(outGroups);
      plan.push({ group: target.id });
      cur = target.id;
      break;
    }
    // append dependencies of final service, cache first; follow chains through
    // queues/services (e.g. ingest → kafka → workers → db) up to a safe depth
    const seen = new Set(plan.map((s) => s.group));
    seen.add(cur);
    let cacheHit = false;
    let frontier = cur;
    for (let depth = 0; depth < 5 && frontier; depth++) {
      const deps = this._downstream(frontier)
        .map((id) => this.groups.get(id))
        .filter((g) => g && !seen.has(g.id));
      deps.sort((a, b) => (a.type === 'cache' ? -1 : 0) - (b.type === 'cache' ? -1 : 0));
      frontier = null;
      for (const d of deps) {
        seen.add(d.id);
        if (d.type === 'cache') {
          plan.push({ group: d.id, kind: 'cache' });
          if (Math.random() < d.cacheHitRate) cacheHit = true;
        } else if (d.type === 'db' || d.type === 'queue' || d.type === 'service') {
          plan.push({ group: d.id, kind: d.type, skipOnCacheHit: cacheHit && d.type === 'db' });
          // continue the chain through pipeline-style hops
          if (d.type === 'queue' || d.type === 'service') frontier = d.id;
        }
      }
    }
    return plan;
  }

  // -- instance selection -----------------------------------------------------
  _edge(from, to) { return this.edges.find((e) => e.from === from && e.to === to); }

  /**
   * Pick an instance in group g reachable from node `fromId`.
   * Honors pool membership (health-check detection), circuit breakers,
   * partitions, and DB primary preference. Least-connections among candidates.
   */
  _pickInstance(fromId, g, excludeId = null) {
    let candidates = g.nodeIds
      .map((id) => this.nodes.get(id))
      .filter((n) => n && n.id !== excludeId && n.inPool && n.state !== NodeState.STARTING);
    if (g.type === 'db') {
      const primaries = candidates.filter((n) => n.role === 'primary');
      if (primaries.length) candidates = primaries; // writes go to primary
    }
    const usable = [];
    for (const n of candidates) {
      const e = this._edge(fromId, n.id);
      if (!e || e.cut) continue;
      if (e.breaker === 'open') continue;
      if (e.breaker === 'half' && e._probeInFlight) continue;
      usable.push({ n, e });
    }
    if (!usable.length) return null;
    usable.sort((a, b) => a.n.inflight - b.n.inflight);
    const chosen = usable[0];
    if (chosen.e.breaker === 'half') chosen.e._probeInFlight = true;
    return chosen;
  }

  _recordEdgeResult(e, ok) {
    if (!e) return;
    e.results.push({ t: this.time, ok });
    e.results = e.results.filter((r) => this.time - r.t < 6000);
    if (e.breaker === 'half') {
      e._probeInFlight = false;
      if (ok) {
        e.breaker = 'closed'; e.results = [];
        this.log('breaker', 'good', `Circuit breaker CLOSED: ${this._nodeName(e.from)} → ${this._nodeName(e.to)} recovered`);
      } else {
        e.breaker = 'open'; e.openedAt = this.time;
        this.log('breaker', 'warn', `Circuit breaker re-OPENED: ${this._nodeName(e.from)} → ${this._nodeName(e.to)} still failing`);
      }
      return;
    }
    if (e.breaker === 'closed') {
      const fails = e.results.filter((r) => !r.ok).length;
      if (fails >= 4 && fails / e.results.length > 0.5) {
        e.breaker = 'open'; e.openedAt = this.time;
        this.log('breaker', 'warn', `Circuit breaker OPEN: ${this._nodeName(e.from)} → ${this._nodeName(e.to)} (failure rate ${Math.round((fails / e.results.length) * 100)}%)`);
        this._ensureIncident('circuit breaker tripped');
      }
    }
  }

  _nodeName(id) { return this.nodes.get(id)?.name || id; }

  // -- request lifecycle --------------------------------------------------------
  _spawnRequest() {
    const plan = this._buildPlan();
    if (!plan || !plan.length) return;
    const client = [...this.groups.values()].find((g) => g.type === 'client');
    const from = this.nodes.get(client.nodeIds[0]);
    if (!from) return;
    const req = {
      id: uid('r'),
      planIdx: 0, plan,
      from: from.id, to: null, edge: null,
      phase: 'route', progress: 0, travelTime: 1,
      processRemaining: 0,
      retries: 0, degraded: false,
      born: this.time,
      status: 'active', // active|done|failed
      trail: from.id,
    };
    this.stats.total++;
    this.requests.push(req);
    this._route(req);
  }

  /** Choose next hop for request (or finish / fail / fallback). */
  _route(req) {
    // skip steps flagged by cache hit
    while (req.planIdx < req.plan.length && req.plan[req.planIdx].skipOnCacheHit) req.planIdx++;
    if (req.planIdx >= req.plan.length) return this._complete(req, true);

    const step = req.plan[req.planIdx];
    const g = this.groups.get(step.group);
    if (!g) return this._complete(req, true);
    const picked = this._pickInstance(req.from, g);

    if (!picked) {
      // Nothing reachable in this group.
      if (step.kind === 'cache') {
        // cache unavailable → miss; continue to db (disable cache-hit skips)
        for (const s of req.plan) s.skipOnCacheHit = false;
        req.degraded = true;
        req.planIdx++;
        return this._route(req);
      }
      if (step.kind === 'db' || step.kind === 'queue') {
        // serve degraded fallback response (stale cache / queued for later)
        this.stats.fallback++;
        req.degraded = true;
        return this._complete(req, true);
      }
      return this._fail(req);
    }

    req.to = picked.n.id;
    req.edge = picked.e;
    req.phase = 'travel';
    req.progress = 0;
    req.travelTime = 260 + picked.e.latencyAdded + rand(0, 60);
  }

  _arrive(req) {
    const n = this.nodes.get(req.to);
    if (!n || n.state === NodeState.DEAD || n.state === NodeState.STARTING) {
      // arrived at a corpse (LB hasn't detected it yet) — classic failure window
      this._recordEdgeResult(req.edge, false);
      return this._retryOrFail(req);
    }
    n.inflight++;
    n.pulse = 1;
    req.phase = 'process';
    const over = Math.max(0, n.inflight / (n.capacity * n.capFactor) - 1);
    const degradedMult = n.state === NodeState.DEGRADED ? 3 : 1;
    req.processRemaining = (n.baseLatency + n.latencyBoost) * degradedMult * (1 + over * 2.5) + rand(0, 25);
    // overload errors
    if (over > 0.6 && Math.random() < 0.25) {
      req._willError = true;
    }
  }

  _finishProcess(req) {
    const n = this.nodes.get(req.to);
    if (n) n.inflight = Math.max(0, n.inflight - 1);
    if (req._willError || (n && n.state === NodeState.DEGRADED && Math.random() < 0.12)) {
      req._willError = false;
      this._recordEdgeResult(req.edge, false);
      return this._retryOrFail(req);
    }
    this._recordEdgeResult(req.edge, true);
    req.from = req.to;
    req.trail = req.to;
    req.planIdx++;
    req.phase = 'route';
    this._route(req);
  }

  _retryOrFail(req) {
    if (req.retries < 2) {
      req.retries++;
      this.stats.retried++;
      req.phase = 'route';
      const excluded = req.to;
      req.to = null;
      // retry from previous node, excluding the instance that just failed
      const step = req.plan[req.planIdx];
      const g = step && this.groups.get(step.group);
      if (g) {
        const picked = this._pickInstance(req.from, g, excluded);
        if (picked) {
          req.to = picked.n.id; req.edge = picked.e;
          req.phase = 'travel'; req.progress = 0;
          req.travelTime = 200 + picked.e.latencyAdded + rand(0, 50);
          return;
        }
        // no alternative instance → same fallback logic as routing
        if (step.kind === 'cache') { req.planIdx++; req.degraded = true; return this._route(req); }
        if (step.kind === 'db' || step.kind === 'queue') { this.stats.fallback++; req.degraded = true; return this._complete(req, true); }
      }
    }
    this._fail(req);
  }

  _complete(req, ok) {
    req.status = ok ? 'done' : 'failed';
    req.doneAt = this.time;
    const lat = this.time - req.born;
    if (ok) { this.stats.ok++; this._bucket.ok++; this._bucket.latSum += lat; this._bucket.latN++; }
    else { this.stats.err++; this._bucket.err++; }
  }

  _fail(req) {
    this.emit('reqfail', { x: req.to || req.from });
    this._complete(req, false);
  }

  // -- chaos actions ------------------------------------------------------------
  killNode(nid, cause = 'chaos') {
    const n = this.nodes.get(nid);
    if (!n || n.state === NodeState.DEAD || n.type === 'client') return false;
    n.state = NodeState.DEAD;
    n.diedAt = this.time;
    n.inflight = 0;
    // NOTE: inPool stays true until health checks detect — realistic failure window
    this.log('chaos', 'crit', `💥 ${cause === 'chaos' ? 'Chaos:' : cause} ${n.name} crashed (${this.groups.get(n.group)?.name})`);
    this._ensureIncident(`${n.name} crashed`);
    this.emit('explosion', { x: n.x, y: n.y });
    return true;
  }

  killRandomInstance() {
    const victims = [...this.nodes.values()].filter(
      (n) => n.state === NodeState.HEALTHY && !['client', 'lb'].includes(n.type)
    );
    if (!victims.length) return null;
    const v = pick(victims);
    this.killNode(v.id);
    return v;
  }

  killDbPrimary() {
    const primary = [...this.nodes.values()].find(
      (n) => n.type === 'db' && n.role === 'primary' && n.state !== NodeState.DEAD
    );
    if (primary) { this.killNode(primary.id, 'Chaos: database failure —'); return primary; }
    return null;
  }

  injectLatency(gid, ms, durationMs) {
    const g = this.groups.get(gid);
    if (!g) return false;
    for (const nid of g.nodeIds) {
      const n = this.nodes.get(nid);
      if (n) { n.latencyBoost = ms; n.latencyBoostUntil = this.time + durationMs; }
    }
    this.log('chaos', 'warn', `🐌 Chaos: +${ms}ms latency injected into "${g.name}" for ${Math.round(durationMs / 1000)}s`);
    this._ensureIncident(`latency injected into ${g.name}`);
    return true;
  }

  partitionGroup(gid, durationMs) {
    const g = this.groups.get(gid);
    if (!g) return false;
    for (const e of this.edges) {
      const toN = this.nodes.get(e.to);
      if (toN && toN.group === gid) { e.cut = true; e.cutUntil = this.time + durationMs; }
    }
    this.log('chaos', 'crit', `✂️ Chaos: network partition — "${g.name}" unreachable for ${Math.round(durationMs / 1000)}s`);
    this._ensureIncident(`network partition on ${g.name}`);
    return true;
  }

  cpuSpike(gid, durationMs) {
    const g = this.groups.get(gid);
    if (!g) return false;
    for (const nid of g.nodeIds) {
      const n = this.nodes.get(nid);
      if (n && n.state === NodeState.HEALTHY) {
        n.capFactor = 0.25; n._cpuUntil = this.time + durationMs;
        n.state = NodeState.DEGRADED;
      }
    }
    this.log('chaos', 'warn', `🔥 Chaos: CPU spike on "${g.name}" — capacity down 75% for ${Math.round(durationMs / 1000)}s`);
    this._ensureIncident(`CPU spike on ${g.name}`);
    return true;
  }

  trafficSpike(mult, durationMs) {
    this.trafficMultiplier = mult;
    this._trafficTimer = this.time + durationMs;
    this.log('chaos', 'warn', `📈 Traffic spike: ${mult}× load for ${Math.round(durationMs / 1000)}s`);
    return true;
  }

  setChaosMonkey(on) {
    this.chaosMonkey = on;
    this.log('chaos', on ? 'warn' : 'info', on ? '🐒 Chaos Monkey UNLEASHED — random failures incoming' : '🐒 Chaos Monkey caged');
  }

  // -- incident tracking ----------------------------------------------------------
  _ensureIncident(cause) {
    if (!this.incident) {
      this.incident = { start: this.time, cause };
      this.log('incident', 'crit', `🚨 INCIDENT started: ${cause}`);
      this.emit('incident', this.incident);
    }
  }

  _checkRecovery() {
    if (!this.incident) return;
    // recovered = all groups at desired capacity, no open breakers/cuts/boosts,
    // and recent success rate healthy
    for (const g of this.groups.values()) {
      if (g.type === 'client') continue;
      const healthy = g.nodeIds.map((id) => this.nodes.get(id))
        .filter((n) => n && n.state === NodeState.HEALTHY && n.inPool).length;
      if (healthy < g.desired) return;
    }
    if (this.edges.some((e) => e.breaker !== 'closed' || e.cut)) return;
    if ([...this.nodes.values()].some((n) => n.latencyBoost > 0 || n.capFactor < 1)) return;
    const recent = this.buckets.slice(-3);
    const ok = recent.reduce((s, b) => s + b.ok, 0);
    const err = recent.reduce((s, b) => s + b.err, 0);
    if (recent.length < 3 || ok + err === 0 || ok / (ok + err) < 0.98) return;

    const mttr = this.time - this.incident.start;
    this.lastMTTR = mttr;
    this.incidents.push({ ...this.incident, end: this.time, mttr });
    this.log('incident', 'good', `✅ System fully recovered — MTTR ${(mttr / 1000).toFixed(1)}s`);
    this.emit('recovered', { mttr, incident: this.incident });
    this.incident = null;
  }

  // -- healing subsystems -----------------------------------------------------------
  _healthChecks() {
    for (const n of this.nodes.values()) {
      if (n.type === 'client') continue;
      if (n.state === NodeState.DEAD) {
        n.healthFails++;
        if (n.inPool && n.healthFails >= 2) {
          n.inPool = false;
          this.log('detect', 'warn', `🩺 Health check: ${n.name} unresponsive (2 consecutive failures) — removed from pool`);
        }
      } else if (n.state !== NodeState.STARTING) {
        n.healthFails = 0;
        if (!n.inPool) {
          n.inPool = true;
          this.log('detect', 'good', `🩺 Health check: ${n.name} passing — added to pool`);
        }
      }
    }
  }

  _orchestrate() {
    for (const g of this.groups.values()) {
      if (!g.autoheal || g.type === 'client') continue;
      const alive = this._aliveNodes(g).length;
      if (alive < g.desired) {
        const boot = rand(g.bootTime[0], g.bootTime[1]);
        const role = g.type === 'db' ? 'replica' : null;
        const n = this._spawnNode(g, role, NodeState.STARTING, boot);
        this.log('orchestrator', 'info', `⚙️ Orchestrator: scheduling replacement ${n.name} (boot ~${(boot / 1000).toFixed(1)}s)`);
      }
      // db failover
      if (g.type === 'db') this._dbFailover(g);
    }
    // clean up corpses after fade period
    for (const n of [...this.nodes.values()]) {
      if (n.state === NodeState.DEAD && this.time - n.diedAt > 7000) this._removeNode(n.id);
    }
  }

  _dbFailover(g) {
    const members = g.nodeIds.map((id) => this.nodes.get(id)).filter(Boolean);
    const primaryAlive = members.some((n) => n.role === 'primary' && n.state !== NodeState.DEAD);
    if (primaryAlive) { g.failoverTimer = null; return; }
    const replicas = members.filter((n) => n.role === 'replica' && n.state === NodeState.HEALTHY);
    if (!replicas.length) return;
    if (g.failoverTimer == null) {
      g.failoverTimer = this.time + 2500;
      this.log('failover', 'warn', `🗳️ ${g.name}: primary lost — leader election started`);
    } else if (this.time >= g.failoverTimer) {
      const promoted = replicas[0];
      promoted.role = 'primary';
      g.failoverTimer = null;
      this.log('failover', 'good', `👑 Failover complete: ${promoted.name} promoted to PRIMARY`);
    }
  }

  _finishBoots(dt) {
    for (const n of this.nodes.values()) {
      if (n.state === NodeState.STARTING) {
        n.bootRemaining -= dt;
        if (n.bootRemaining <= 0) {
          n.state = NodeState.HEALTHY;
          n.inPool = true;
          this.log('orchestrator', 'good', `🟢 ${n.name} is up — joined the load balancing pool`);
        }
      }
      // expire latency boosts / cpu spikes
      if (n.latencyBoost > 0 && this.time > n.latencyBoostUntil) {
        n.latencyBoost = 0;
      }
      if (n.capFactor < 1 && this.time > n._cpuUntil) {
        n.capFactor = 1;
        if (n.state === NodeState.DEGRADED) n.state = NodeState.HEALTHY;
      }
      // load-based degradation for healthy nodes
      if (n.state === NodeState.HEALTHY && n.inflight > n.capacity * n.capFactor * 1.4) {
        n.state = NodeState.DEGRADED;
        this.log('detect', 'warn', `⚠️ ${n.name} overloaded (${n.inflight} in-flight) — degraded`);
      } else if (n.state === NodeState.DEGRADED && n.capFactor >= 1 && n.inflight < n.capacity * 0.7) {
        n.state = NodeState.HEALTHY;
      }
    }
    // expire partitions & half-open breakers
    for (const e of this.edges) {
      if (e.cut && e.cutUntil && this.time > e.cutUntil) {
        e.cut = false;
      }
      if (e.breaker === 'open' && this.time - e.openedAt > 4000) {
        e.breaker = 'half';
        e._probeInFlight = false;
        this.log('breaker', 'info', `🔎 Circuit breaker HALF-OPEN: probing ${this._nodeName(e.from)} → ${this._nodeName(e.to)}`);
      }
    }
  }

  _monkeyTick(dt) {
    if (!this.chaosMonkey) return;
    this._acc.monkey -= dt;
    if (this._acc.monkey <= 0) {
      this._acc.monkey = rand(6000, 14000);
      const roll = Math.random();
      if (roll < 0.5) this.killRandomInstance();
      else if (roll < 0.7) {
        const gs = [...this.groups.values()].filter((g) => !['client', 'lb'].includes(g.type));
        if (gs.length) this.injectLatency(pick(gs).id, Math.round(rand(200, 800)), rand(6000, 12000));
      } else if (roll < 0.85) {
        const gs = [...this.groups.values()].filter((g) => ['cache', 'db', 'queue'].includes(g.type));
        if (gs.length) this.partitionGroup(pick(gs).id, rand(5000, 9000));
      } else this.trafficSpike(Math.round(rand(2, 4)), rand(8000, 15000));
    }
  }

  // -- scenario scheduling -------------------------------------------------------
  /** actions: [{op, ...args}] executed via runAction with `wait` support. */
  runScenario(actions, label = 'AI scenario') {
    let at = this.time;
    let count = 0;
    for (const a of actions) {
      if (a.op === 'wait') { at += (a.seconds ?? 2) * 1000; continue; }
      this.schedule.push({ at, action: a, label });
      count++;
    }
    this.log('scenario', 'info', `🎬 Scenario "${label}" queued (${count} actions)`);
  }

  /** Execute one structured action (shared by AI + scenarios). Returns msg. */
  runAction(a) {
    const g = a.group ? this.groupByName(a.group) : null;
    switch (a.op) {
      case 'kill_node': {
        if (g) {
          const alive = this._aliveNodes(g).filter((n) => n.state === NodeState.HEALTHY);
          if (alive.length) { this.killNode(alive[0].id); return `killed ${alive[0].name}`; }
          return `no healthy instance in ${a.group}`;
        }
        const v = this.killRandomInstance();
        return v ? `killed ${v.name}` : 'nothing to kill';
      }
      case 'kill_db_primary': { const v = this.killDbPrimary(); return v ? `killed ${v.name}` : 'no primary found'; }
      case 'inject_latency': return g ? (this.injectLatency(g.id, a.ms ?? 500, (a.duration ?? 10) * 1000), `latency on ${g.name}`) : `group not found: ${a.group}`;
      case 'partition': return g ? (this.partitionGroup(g.id, (a.duration ?? 8) * 1000), `partitioned ${g.name}`) : `group not found: ${a.group}`;
      case 'cpu_spike': return g ? (this.cpuSpike(g.id, (a.duration ?? 10) * 1000), `cpu spike on ${g.name}`) : `group not found: ${a.group}`;
      case 'set_traffic': return (this.trafficSpike(a.multiplier ?? 2, (a.duration ?? 15) * 1000), `traffic ×${a.multiplier ?? 2}`);
      case 'set_rps': { this.rps = Math.max(1, Math.min(80, a.rps ?? 14)); return `base traffic set to ${this.rps} rps`; }
      case 'set_replicas': return g ? (this.setDesired(g.id, a.count ?? 2), `replicas of ${g.name} → ${a.count}`) : `group not found: ${a.group}`;
      case 'chaos_monkey': return (this.setChaosMonkey(!!a.on), `chaos monkey ${a.on ? 'on' : 'off'}`);
      default: return `unknown op: ${a.op}`;
    }
  }

  // -- serialization for AI ---------------------------------------------------------
  snapshot() {
    const groups = [...this.groups.values()].map((g) => ({
      name: g.name, type: g.type, desiredReplicas: g.desired,
      instances: g.nodeIds.map((id) => {
        const n = this.nodes.get(id);
        return n ? { name: n.name, state: n.state, role: n.role || undefined, inLbPool: n.inPool, inflight: n.inflight } : null;
      }).filter(Boolean),
    }));
    const links = this.groupLinks.map((l) => `${this.groups.get(l.from)?.name} -> ${this.groups.get(l.to)?.name}`);
    const recent = this.buckets.slice(-30);
    const ok = recent.reduce((s, b) => s + b.ok, 0), err = recent.reduce((s, b) => s + b.err, 0);
    return {
      simTimeSec: Math.round(this.time / 1000),
      groups, links,
      openCircuitBreakers: this.edges.filter((e) => e.breaker !== 'closed')
        .map((e) => `${this._nodeName(e.from)} -> ${this._nodeName(e.to)} (${e.breaker})`),
      metrics: {
        baseRps: this.rps, trafficMultiplier: this.trafficMultiplier,
        successRateLast30s: ok + err ? +(100 * ok / (ok + err)).toFixed(1) : 100,
        avgLatencyMs: recent.length ? Math.round(recent.reduce((s, b) => s + b.lat, 0) / recent.length) : 0,
        totals: { ...this.stats },
        lastMTTRSec: this.lastMTTR ? +(this.lastMTTR / 1000).toFixed(1) : null,
      },
      activeIncident: this.incident ? { cause: this.incident.cause, ongoingForSec: Math.round((this.time - this.incident.start) / 1000) } : null,
      chaosMonkey: this.chaosMonkey,
    };
  }

  recentEventsText(n = 40) {
    return this.events.slice(-n)
      .map((e) => `[t+${(e.t / 1000).toFixed(1)}s][${e.type}] ${e.msg}`)
      .join('\n');
  }

  // -- main tick ---------------------------------------------------------------------
  tick(dtReal) {
    if (!this.running) return;
    const dt = Math.min(dtReal, 100) * this.speed;
    this.time += dt;

    // scheduled scenario actions
    if (this.schedule.length) {
      const due = this.schedule.filter((s) => s.at <= this.time);
      this.schedule = this.schedule.filter((s) => s.at > this.time);
      for (const s of due) this.runAction(s.action);
    }

    // traffic spike expiry
    if (this.trafficMultiplier !== 1 && this.time > this._trafficTimer) {
      this.trafficMultiplier = 1;
      this.log('chaos', 'info', '📉 Traffic returned to normal');
    }

    // spawn requests
    this._acc.spawn += dt;
    const interval = 1000 / (this.rps * this.trafficMultiplier);
    while (this._acc.spawn >= interval) {
      this._acc.spawn -= interval;
      if (this.requests.filter((r) => r.status === 'active').length < 400) this._spawnRequest();
    }

    // advance requests
    for (const r of this.requests) {
      if (r.status !== 'active') continue;
      if (r.phase === 'travel') {
        r.progress += dt / r.travelTime;
        if (r.progress >= 1) this._arrive(r);
      } else if (r.phase === 'process') {
        r.processRemaining -= dt;
        if (r.processRemaining <= 0) this._finishProcess(r);
      }
    }
    // reap finished (keep short grace for render fade)
    this.requests = this.requests.filter((r) => r.status === 'active' || this.time - r.doneAt < 400);

    // subsystems
    this._acc.health += dt;
    if (this._acc.health >= 800) { this._acc.health = 0; this._healthChecks(); }
    this._acc.orch += dt;
    if (this._acc.orch >= 1000) { this._acc.orch = 0; this._orchestrate(); this._checkRecovery(); }
    this._finishBoots(dt);
    this._monkeyTick(dt);

    // metrics buckets
    this._acc.metric += dt;
    if (this._acc.metric >= 1000) {
      this._acc.metric = 0;
      const b = this._bucket;
      this.buckets.push({
        t: this.time, ok: b.ok, err: b.err,
        lat: b.latN ? Math.round(b.latSum / b.latN) : 0,
        inflight: this.requests.filter((r) => r.status === 'active').length,
      });
      if (this.buckets.length > 180) this.buckets.shift();
      this._bucket = { ok: 0, err: 0, latSum: 0, latN: 0 };
    }
  }
}
