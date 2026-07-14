/**
 * Canvas renderer: animated topology map with traffic particles, node states,
 * circuit breaker indicators, explosions, pan/zoom.
 */
import { NodeState } from '../engine/engine.js';

const COLORS = {
  healthy: '#2dd4a7',
  degraded: '#f5b342',
  starting: '#4da3ff',
  dead: '#ff4d5e',
  edge: 'rgba(120,145,190,0.16)',
  edgeCut: 'rgba(255,77,94,0.45)',
  particle: '#67e8f9',
  particleErr: '#ff4d5e',
  particleDegraded: '#f5b342',
  label: '#8ea2c9',
  labelBright: '#dbe6ff',
};

const TYPE_ICONS = {
  client: '🌐', lb: '⚖', gateway: '🚪', service: '⬢', cache: '⚡', db: '🗄', queue: '📬',
};

export class Renderer {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.explosions = [];
    this.sparks = [];
    this.hoverNode = null;
    this._fitDone = false;

    engine.on('explosion', ({ x, y }) => this.explosions.push({ x, y, t: 0 }));

    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
  }

  fit() {
    const ns = [...this.engine.nodes.values()];
    if (!ns.length) return;
    const pad = 90;
    const minX = Math.min(...ns.map((n) => n.x)) - pad, maxX = Math.max(...ns.map((n) => n.x)) + pad;
    const minY = Math.min(...ns.map((n) => n.y)) - pad, maxY = Math.max(...ns.map((n) => n.y)) + pad;
    const zx = this.w / (maxX - minX), zy = this.h / (maxY - minY);
    this.cam.zoom = Math.min(zx, zy, 1.4);
    this.cam.x = (minX + maxX) / 2 - this.w / 2 / this.cam.zoom;
    this.cam.y = (minY + maxY) / 2 - this.h / 2 / this.cam.zoom;
  }

  toWorld(px, py) {
    return { x: px / this.cam.zoom + this.cam.x, y: py / this.cam.zoom + this.cam.y };
  }

  _bindInput() {
    let dragging = false, lx = 0, ly = 0;
    this.canvas.addEventListener('mousedown', (e) => { dragging = true; lx = e.offsetX; ly = e.offsetY; });
    window.addEventListener('mouseup', () => (dragging = false));
    this.canvas.addEventListener('mousemove', (e) => {
      if (dragging) {
        this.cam.x -= (e.offsetX - lx) / this.cam.zoom;
        this.cam.y -= (e.offsetY - ly) / this.cam.zoom;
        lx = e.offsetX; ly = e.offsetY;
      }
      const w = this.toWorld(e.offsetX, e.offsetY);
      this.hoverNode = this._nodeAt(w.x, w.y);
      this.canvas.style.cursor = this.hoverNode ? 'pointer' : dragging ? 'grabbing' : 'grab';
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e.offsetX, e.offsetY);
      this.cam.zoom = Math.max(0.3, Math.min(3, this.cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const after = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
    }, { passive: false });
    this.canvas.addEventListener('click', (e) => {
      const w = this.toWorld(e.offsetX, e.offsetY);
      const n = this._nodeAt(w.x, w.y);
      if (n && this.onNodeClick) this.onNodeClick(n);
    });
    this.canvas.addEventListener('dblclick', () => this.fit());
  }

  _nodeAt(x, y) {
    for (const n of this.engine.nodes.values()) {
      if (Math.hypot(n.x - x, n.y - y) < 30) return n;
    }
    return null;
  }

  nodePos(id) { const n = this.engine.nodes.get(id); return n ? { x: n.x, y: n.y } : null; }

  frame(dt) {
    if (!this._fitDone && this.engine.nodes.size) { this.fit(); this._fitDone = true; }
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    this._grid();

    ctx.save();
    ctx.scale(this.cam.zoom, this.cam.zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    this._edges();
    this._particles();
    this._nodes(dt);
    this._explosions(dt);

    ctx.restore();
    this._hoverTip();
  }

  refit() { this._fitDone = false; }

  _grid() {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(90,110,160,0.06)';
    ctx.lineWidth = 1;
    const step = 44 * this.cam.zoom;
    const ox = (-this.cam.x * this.cam.zoom) % step, oy = (-this.cam.y * this.cam.zoom) % step;
    for (let x = ox; x < this.w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke(); }
    for (let y = oy; y < this.h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke(); }
    ctx.restore();
  }

  _edgePath(a, b) {
    const mx = (a.x + b.x) / 2;
    return { c1x: mx, c1y: a.y, c2x: mx, c2y: b.y };
  }

  _edges() {
    const { ctx } = this;
    for (const e of this.engine.edges) {
      const a = this.nodePos(e.from), b = this.nodePos(e.to);
      if (!a || !b) continue;
      const p = this._edgePath(a, b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(p.c1x, p.c1y, p.c2x, p.c2y, b.x, b.y);
      if (e.cut) {
        ctx.strokeStyle = COLORS.edgeCut; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.6;
      } else if (e.breaker === 'open') {
        ctx.strokeStyle = 'rgba(245,179,66,0.5)'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1.6;
      } else if (e.breaker === 'half') {
        ctx.strokeStyle = 'rgba(77,163,255,0.5)'; ctx.setLineDash([10, 4]); ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = COLORS.edge; ctx.setLineDash([]); ctx.lineWidth = 1.4;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // breaker badge at midpoint
      if (e.breaker !== 'closed' || e.cut) {
        const t = 0.5;
        const pt = bezier(a, p, b, t);
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(e.cut ? '✂️' : e.breaker === 'open' ? '⛔' : '🔎', pt.x, pt.y);
      }
    }
  }

  _particles() {
    const { ctx } = this;
    for (const r of this.engine.requests) {
      if (r.status !== 'active' || r.phase !== 'travel' || !r.to) continue;
      const a = this.nodePos(r.from), b = this.nodePos(r.to);
      if (!a || !b) continue;
      const p = this._edgePath(a, b);
      const pt = bezier(a, p, b, Math.min(1, r.progress));
      const color = r.retries > 0 ? COLORS.particleDegraded : r.degraded ? COLORS.particleDegraded : COLORS.particle;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  _nodes(dt) {
    const { ctx } = this;
    const t = performance.now() / 1000;

    // group labels
    for (const g of this.engine.groups.values()) {
      const ns = g.nodeIds.map((id) => this.engine.nodes.get(id)).filter(Boolean);
      if (!ns.length) continue;
      const minY = Math.min(...ns.map((n) => n.y));
      const cx = ns.reduce((s, n) => s + n.x, 0) / ns.length;
      ctx.font = '600 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.label;
      const healthy = ns.filter((n) => n.state === NodeState.HEALTHY).length;
      ctx.fillText(`${g.name}  ${g.type !== 'client' && g.desired > 1 ? `${healthy}/${g.desired}` : ''}`, cx, minY - 34);
    }

    for (const n of this.engine.nodes.values()) {
      const color = COLORS[n.state] || COLORS.healthy;
      const dead = n.state === NodeState.DEAD;
      const fade = dead ? Math.max(0.15, 1 - (this.engine.time - n.diedAt) / 7000) : 1;
      const r = 22;

      ctx.save();
      ctx.globalAlpha = fade;

      // pulse ring for busy/starting nodes
      if (!dead) {
        const pulse = n.state === NodeState.STARTING
          ? (t * 2) % 1
          : n.inflight > 0 ? (t * 1.2 + n.x * 0.01) % 1 : 0;
        if (pulse > 0) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + pulse * 14, 0, Math.PI * 2);
          ctx.strokeStyle = color + Math.round((1 - pulse) * 60).toString(16).padStart(2, '0');
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // body
      ctx.beginPath();
      roundHex(ctx, n.x, n.y, r);
      ctx.fillStyle = '#101828';
      ctx.shadowColor = color; ctx.shadowBlur = dead ? 4 : 14;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      // load bar
      if (!dead && n.type !== 'client') {
        const load = Math.min(1, n.inflight / (n.capacity * n.capFactor));
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(n.x - 16, n.y + r + 5, 32, 3.5);
        ctx.fillStyle = load > 0.85 ? COLORS.dead : load > 0.6 ? COLORS.degraded : color;
        ctx.fillRect(n.x - 16, n.y + r + 5, 32 * load, 3.5);
      }

      // icon + name
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(dead ? '☠' : TYPE_ICONS[n.type] || '⬢', n.x, n.y - 2);
      ctx.font = '10px Inter, sans-serif';
      ctx.fillStyle = COLORS.labelBright;
      ctx.fillText(n.name, n.x, n.y + r + 18);
      if (n.role) {
        ctx.fillStyle = n.role === 'primary' ? '#f5b342' : COLORS.label;
        ctx.font = '9px Inter, sans-serif';
        ctx.fillText(n.role === 'primary' ? '★ primary' : 'replica', n.x, n.y + r + 29);
      }
      if (n.state === NodeState.STARTING) {
        ctx.fillStyle = COLORS.starting;
        ctx.font = '9px Inter, sans-serif';
        ctx.fillText(`booting ${(Math.max(0, n.bootRemaining) / 1000).toFixed(1)}s`, n.x, n.y + r + (n.role ? 40 : 29));
      }
      ctx.restore();
    }
  }

  _explosions(dt) {
    const { ctx } = this;
    for (const ex of this.explosions) {
      ex.t += dt;
      const p = ex.t / 700;
      if (p >= 1) continue;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, 10 + p * 55, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,77,94,${(1 - p) * 0.8})`;
      ctx.lineWidth = 3 * (1 - p);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, 4 + p * 30, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,170,60,${(1 - p) * 0.6})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    this.explosions = this.explosions.filter((e) => e.t < 700);
  }

  _hoverTip() {
    const n = this.hoverNode;
    if (!n || !this.engine.nodes.has(n.id)) return;
    const { ctx } = this;
    const sx = (n.x - this.cam.x) * this.cam.zoom;
    const sy = (n.y - this.cam.y) * this.cam.zoom;
    const lines = [
      `${n.name}  [${n.state.toUpperCase()}]`,
      `type: ${n.type}${n.role ? ' (' + n.role + ')' : ''}`,
      `in-flight: ${n.inflight} / cap ${Math.round(n.capacity * n.capFactor)}`,
      `latency: ~${Math.round(n.baseLatency + n.latencyBoost)}ms${n.latencyBoost ? ' (+chaos)' : ''}`,
      n.inPool ? 'in LB pool ✓' : 'OUT of LB pool ✗',
      'click to kill ☠',
    ];
    ctx.font = '11px Inter, sans-serif';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const h = lines.length * 16 + 12;
    let x = sx + 30, y = sy - h / 2;
    if (x + w > this.w) x = sx - w - 30;
    y = Math.max(8, Math.min(this.h - h - 8, y));
    ctx.fillStyle = 'rgba(10,14,23,0.92)';
    ctx.strokeStyle = 'rgba(120,145,190,0.35)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#dbe6ff' : i === lines.length - 1 ? '#ff8d99' : '#8ea2c9';
      ctx.fillText(l, x + 10, y + 8 + i * 16);
    });
  }
}

function bezier(a, p, b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * p.c1x + 3 * u * t * t * p.c2x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * p.c1y + 3 * u * t * t * p.c2y + t * t * t * b.y,
  };
}

function roundHex(ctx, cx, cy, r) {
  const sides = 6, rot = Math.PI / 6;
  for (let i = 0; i <= sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}
