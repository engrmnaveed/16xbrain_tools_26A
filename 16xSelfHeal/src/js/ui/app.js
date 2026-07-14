/**
 * 16x SelfHeal — application bootstrap & UI wiring.
 */
import { Engine, NodeState } from '../engine/engine.js';
import { PRESETS, loadPreset } from '../engine/presets.js';
import { Renderer } from './canvas.js';
import { AI, parseActions, stripActions } from '../ai/ai.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const engine = new Engine();
const canvas = $('#canvas');
const renderer = new Renderer(canvas, engine);
const ai = new AI(engine);

// ───────────────────────── toasts ─────────────────────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3600);
  setTimeout(() => el.remove(), 4100);
}

// ───────────────────────── presets & topology selectors ─────────────────────────
const presetSel = $('#preset-select');
for (const [key, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = key; o.textContent = p.name;
  presetSel.appendChild(o);
}
presetSel.value = 'ecommerce';

function applyPreset(key) {
  loadPreset(engine, key);
  engine.rps = +$('#rps-slider').value;
  renderer.refit();
  refreshGroupSelectors();
  $('#incident-list').innerHTML = '<div class="muted">No incidents yet. Push the big red button. 😈</div>';
  $('#event-log').innerHTML = '';
  renderAllEvents();
}
presetSel.addEventListener('change', () => applyPreset(presetSel.value));

function groupOptions(filter = () => true) {
  return [...engine.groups.values()].filter((g) => g.type !== 'client' && filter(g));
}
function fillSelect(sel, groups, keepValue = true) {
  const prev = sel.value;
  sel.innerHTML = '';
  for (const g of groups) {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = `${g.name} (${g.type})`;
    sel.appendChild(o);
  }
  if (keepValue && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
function refreshGroupSelectors() {
  fillSelect($('#chaos-target'), groupOptions((g) => g.type !== 'lb'));
  fillSelect($('#scale-target'), groupOptions((g) => !['lb'].includes(g.type)));
  fillSelect($('#new-from'), groupOptions((g) => ['lb', 'gateway', 'service'].includes(g.type)));
  const dep = $('#new-dep');
  const prev = dep.value;
  dep.innerHTML = '<option value="">none</option>';
  for (const g of groupOptions((g) => ['cache', 'db', 'queue'].includes(g.type))) {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = `${g.name} (${g.type})`;
    dep.appendChild(o);
  }
  if ([...dep.options].some((o) => o.value === prev)) dep.value = prev;
  updateScaleCount();
}
function updateScaleCount() {
  const g = engine.groups.get($('#scale-target').value);
  $('#scale-count').textContent = g ? g.desired : '–';
}
$('#scale-target').addEventListener('change', updateScaleCount);

// ───────────────────────── top bar controls ─────────────────────────
$('#btn-pause').addEventListener('click', togglePause);
function togglePause() {
  engine.running = !engine.running;
  $('#btn-pause').textContent = engine.running ? '⏸' : '▶';
}
$('#speed-select').addEventListener('change', (e) => (engine.speed = +e.target.value));
$('#rps-slider').addEventListener('input', (e) => {
  engine.rps = +e.target.value;
  $('#rps-val').textContent = `${e.target.value} rps`;
});
$('#btn-reset').addEventListener('click', () => { applyPreset(presetSel.value); toast('Topology reset'); });

// ───────────────────────── chaos controls ─────────────────────────
$('#chaos-random').addEventListener('click', () => {
  const v = engine.killRandomInstance();
  if (!v) toast('Nothing healthy left to kill 💀', 'bad');
});
$('#chaos-kill-primary').addEventListener('click', () => {
  if (!engine.killDbPrimary()) toast('No live DB primary found', 'bad');
});
const targetGroup = () => engine.groups.get($('#chaos-target').value);
$('#chaos-partition').addEventListener('click', () => { const g = targetGroup(); g && engine.partitionGroup(g.id, 8000); });
$('#chaos-latency').addEventListener('click', () => { const g = targetGroup(); g && engine.injectLatency(g.id, 500, 10000); });
$('#chaos-cpu').addEventListener('click', () => { const g = targetGroup(); g && engine.cpuSpike(g.id, 10000); });
$('#chaos-traffic').addEventListener('click', () => engine.trafficSpike(3, 15000));
$('#chaos-monkey').addEventListener('click', () => {
  engine.setChaosMonkey(!engine.chaosMonkey);
  $('#chaos-monkey').classList.toggle('active', engine.chaosMonkey);
  $('#s-monkey').classList.toggle('hidden', !engine.chaosMonkey);
});

renderer.onNodeClick = (n) => {
  if (n.type === 'client') return toast('The internet is not yours to kill 😄');
  if (n.state === NodeState.DEAD) return;
  engine.killNode(n.id, 'Manual kill:');
};

// ───────────────────────── built-in scenarios (work without AI) ─────────────────────────
const LOCAL_SCENARIOS = {
  'black-friday': {
    label: 'Black Friday surge',
    actions: [
      { op: 'set_traffic', multiplier: 3, duration: 40 },
      { op: 'wait', seconds: 6 },
      { op: 'kill_node' },
      { op: 'wait', seconds: 8 },
      { op: 'inject_latency', group: 'db', ms: 400, duration: 12 },
    ],
  },
  'dc-flake': {
    label: 'Flaky datacenter',
    actions: [
      { op: 'inject_latency', group: 'service', ms: 600, duration: 10 },
      { op: 'wait', seconds: 4 },
      { op: 'partition', group: 'cache', duration: 8 },
      { op: 'wait', seconds: 6 },
      { op: 'kill_node' },
    ],
  },
  'cascade': {
    label: 'Cascading failure',
    actions: [
      { op: 'kill_node' },
      { op: 'wait', seconds: 3 },
      { op: 'kill_node' },
      { op: 'wait', seconds: 3 },
      { op: 'kill_db_primary' },
      { op: 'wait', seconds: 5 },
      { op: 'set_traffic', multiplier: 2, duration: 15 },
    ],
  },
};
$$('.scenario').forEach((btn) =>
  btn.addEventListener('click', () => {
    const sc = LOCAL_SCENARIOS[btn.dataset.scenario];
    engine.runScenario(sc.actions, sc.label);
    toast(`🎬 Running: ${sc.label}`);
  })
);

// ───────────────────────── topology editing ─────────────────────────
$('#scale-up').addEventListener('click', () => scale(+1));
$('#scale-down').addEventListener('click', () => scale(-1));
function scale(d) {
  const g = engine.groups.get($('#scale-target').value);
  if (!g) return;
  engine.setDesired(g.id, g.desired + d);
  updateScaleCount();
}
$('#new-create').addEventListener('click', () => {
  const name = $('#new-name').value.trim();
  if (!name) return toast('Give the service a name', 'bad');
  if (engine.groupByName(name)) return toast('Name already in use', 'bad');
  const fromG = engine.groups.get($('#new-from').value);
  if (!fromG) return toast('Pick an upstream group', 'bad');
  const replicas = Math.max(1, Math.min(6, +$('#new-replicas').value || 2));
  const xs = [...engine.groups.values()].map((g) => g.x);
  const ys = [...engine.groups.values()].map((g) => g.y);
  const g = engine.addGroup({
    name, type: 'service', replicas,
    x: fromG.x + 240, y: Math.max(...ys) + 140 - Math.min(0, 0),
    capacity: 22, baseLatency: 45,
  });
  engine.connectGroups(fromG.id, g.id);
  const dep = $('#new-dep').value;
  if (dep) engine.connectGroups(g.id, dep);
  engine.log('topology', 'info', `Service group "${name}" added (${replicas} replicas)`);
  refreshGroupSelectors();
  renderer.refit();
  $('#new-name').value = '';
  toast(`Service "${name}" deployed ✓`, 'good');
});

// ───────────────────────── tabs ─────────────────────────
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.tab-page').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
  })
);

// ───────────────────────── event log ─────────────────────────
const logEl = $('#event-log');
const filters = { chaos: true, detect: true, orchestrator: true, breaker: true, failover: true };
$$('.event-filter input').forEach((cb) =>
  cb.addEventListener('change', () => { filters[cb.dataset.f] = cb.checked; renderAllEvents(); })
);
function evVisible(e) {
  if (e.type in filters) return filters[e.type];
  return true; // incident, scenario, topology always shown
}
function evHtml(e) {
  return `<div class="ev ${e.severity}"><span class="t">t+${(e.t / 1000).toFixed(1)}s</span><span>${escapeHtml(e.msg)}</span></div>`;
}
function renderAllEvents() {
  logEl.innerHTML = engine.events.filter(evVisible).map(evHtml).join('');
  logEl.scrollTop = logEl.scrollHeight;
}
engine.on('event', (e) => {
  if (!evVisible(e)) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  logEl.insertAdjacentHTML('beforeend', evHtml(e));
  while (logEl.children.length > 400) logEl.firstChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
});
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// incident lifecycle → UI
engine.on('incident', (inc) => {
  $('#incident-banner').classList.remove('hidden');
  $('#incident-cause').textContent = inc.cause;
});
engine.on('recovered', ({ mttr, incident }) => {
  $('#incident-banner').classList.add('hidden');
  toast(`✅ Recovered in ${(mttr / 1000).toFixed(1)}s`, 'good');
  const list = $('#incident-list');
  if (list.querySelector('.muted')) list.innerHTML = '';
  list.insertAdjacentHTML('afterbegin',
    `<div class="incident-item">${escapeHtml(incident.cause)} → <b>MTTR ${(mttr / 1000).toFixed(1)}s</b></div>`);
});

// ───────────────────────── metrics panel ─────────────────────────
const tCtx = $('#chart-throughput').getContext('2d');
const lCtx = $('#chart-latency').getContext('2d');
function drawCharts() {
  const buckets = engine.buckets.slice(-90);
  drawBars(tCtx, buckets);
  drawLine(lCtx, buckets);
}
function sizeChart(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = 70 * dpr; cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); }
  return { w, h: 70 };
}
function drawBars(ctx, buckets) {
  const { w, h } = sizeChart(ctx.canvas);
  ctx.clearRect(0, 0, w, h);
  if (!buckets.length) return;
  const max = Math.max(5, ...buckets.map((b) => b.ok + b.err));
  const bw = w / 90;
  buckets.forEach((b, i) => {
    const x = w - (buckets.length - i) * bw;
    const hOk = (b.ok / max) * (h - 6);
    const hErr = (b.err / max) * (h - 6);
    ctx.fillStyle = '#2dd4a7';
    ctx.fillRect(x, h - hOk, bw - 1.5, hOk);
    ctx.fillStyle = '#ff4d5e';
    ctx.fillRect(x, h - hOk - hErr, bw - 1.5, hErr);
  });
}
function drawLine(ctx, buckets) {
  const { w, h } = sizeChart(ctx.canvas);
  ctx.clearRect(0, 0, w, h);
  if (buckets.length < 2) return;
  const max = Math.max(100, ...buckets.map((b) => b.lat));
  ctx.beginPath();
  buckets.forEach((b, i) => {
    const x = w - (buckets.length - i) * (w / 90);
    const y = h - 4 - (b.lat / max) * (h - 10);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.fillStyle = 'rgba(142,162,201,0.8)';
  ctx.font = '10px monospace';
  ctx.fillText(`${max}ms`, 6, 12);
}

function updateStats() {
  const recent = engine.buckets.slice(-30);
  const ok = recent.reduce((s, b) => s + b.ok, 0);
  const err = recent.reduce((s, b) => s + b.err, 0);
  const rate = ok + err ? (100 * ok) / (ok + err) : 100;
  const el = $('#m-success');
  el.textContent = `${rate.toFixed(rate < 99.95 ? 1 : 0)}%`;
  el.style.color = rate > 99 ? 'var(--good)' : rate > 90 ? 'var(--warn)' : 'var(--bad)';
  const last = engine.buckets.slice(-5);
  $('#m-rps').textContent = last.length ? Math.round(last.reduce((s, b) => s + b.ok + b.err, 0) / last.length) : 0;
  $('#m-latency').textContent = `${last.length ? Math.round(last.reduce((s, b) => s + b.lat, 0) / last.length) : 0}ms`;
  let healthy = 0, desired = 0;
  for (const g of engine.groups.values()) {
    if (g.type === 'client') continue;
    desired += g.desired;
    healthy += g.nodeIds.map((id) => engine.nodes.get(id)).filter((n) => n && n.state === NodeState.HEALTHY).length;
  }
  $('#m-instances').textContent = `${healthy}/${desired}`;
  $('#m-instances').style.color = healthy >= desired ? 'var(--good)' : 'var(--warn)';
  $('#m-mttr').textContent = engine.lastMTTR ? `${(engine.lastMTTR / 1000).toFixed(1)}s` : '–';
  $('#m-fallback').textContent = engine.stats.fallback;
  $('#s-time').textContent = `t+${Math.floor(engine.time / 1000)}s`;
  $('#s-active').textContent = `${engine.requests.filter((r) => r.status === 'active').length} in flight`;
  if (engine.incident) {
    $('#incident-timer').textContent = `${Math.floor((engine.time - engine.incident.start) / 1000)}s`;
  }
}

// ───────────────────────── AI copilot ─────────────────────────
const chatEl = $('#ai-chat');

function aiStatusRefresh() {
  const on = ai.configured;
  $('#ai-status').textContent = on ? `AI: ${(ai.settings.model || 'auto').split('/').pop()}` : 'AI: off';
  $('#ai-status').classList.toggle('on', on);
  $('#ai-dot').classList.toggle('on', on);
  $('#ai-setup').classList.toggle('hidden', on);
}

function mdLite(text) {
  let h = escapeHtml(text);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  return h;
}

function addMsg(role, text, actions = null) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = role === 'ai' ? mdLite(text) : escapeHtml(text);
  if (actions && actions.length) {
    const btn = document.createElement('button');
    btn.className = 'run-actions';
    btn.textContent = `▶ Run ${actions.length} action${actions.length > 1 ? 's' : ''}`;
    btn.addEventListener('click', () => {
      engine.runScenario(actions, 'AI actions');
      btn.disabled = true;
      btn.textContent = '✓ Running in simulator';
      toast('🤖 AI actions queued in the simulator', 'good');
    });
    el.appendChild(btn);
  }
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}

async function aiRun(label, fn) {
  if (!ai.configured) {
    $$('.tab')[2].click();
    toast('Add an OpenRouter API key in Settings first', 'bad');
    return;
  }
  if (ai.busy) return toast('AI is already thinking…');
  ai.busy = true;
  const thinking = addMsg('think', `${label}…`);
  try {
    const reply = await fn();
    thinking.remove();
    const actions = parseActions(reply);
    addMsg('ai', stripActions(reply) || '(actions only)', actions);
  } catch (err) {
    thinking.remove();
    const msg = String(err.message || err);
    addMsg('ai', msg.includes('NO_KEY') ? 'No API key configured — open Settings.' : `⚠ ${msg}`);
  } finally {
    ai.busy = false;
  }
}

$('#ai-send').addEventListener('click', sendChat);
$('#ai-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
function sendChat() {
  const text = $('#ai-input').value.trim();
  if (!text) return;
  $('#ai-input').value = '';
  addMsg('user', text);
  aiRun('Thinking', () => ai.ask(text));
}

$$('.ai-q').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab')[2].click();
    const kind = btn.dataset.ai;
    if (kind === 'review') { addMsg('user', 'Review this architecture'); aiRun('Reviewing architecture', () => ai.architectureReview()); }
    if (kind === 'postmortem') {
      if (!engine.incidents.length && !engine.incident) return toast('No incidents yet — break something first 💥');
      addMsg('user', 'Write a post-mortem for the last incident');
      aiRun('Writing post-mortem', () => ai.postMortem());
    }
    if (kind === 'explain') { addMsg('user', 'Explain what just happened (plain words)'); aiRun('Watching the replay', () => ai.explain()); }
  })
);

$('#ai-scenario-btn').addEventListener('click', () => {
  const desc = $('#ai-scenario-input').value.trim();
  if (!desc) return toast('Describe the scenario first, e.g. “region outage during peak”');
  $$('.tab')[2].click();
  addMsg('user', `Generate chaos scenario: ${desc}`);
  $('#ai-scenario-input').value = '';
  aiRun('Designing scenario', () => ai.generateScenario(desc));
});
$('#ai-scenario-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ai-scenario-btn').click(); });
$('#ai-open-settings').addEventListener('click', () => openSettings());

// AI proactive nudge: after first recovery, suggest a post-mortem (once)
let nudged = false;
engine.on('recovered', () => {
  if (nudged || !ai.configured) return;
  nudged = true;
  addMsg('ai', 'That was your first full self-healing cycle 🎉 — want a **post-mortem**? Hit the 📋 button above and I\'ll write one from the real event timeline.');
});

// ───────────────────────── settings ─────────────────────────
const settingsModal = $('#settings-modal');
function openSettings() {
  $('#set-key').value = ai.settings.apiKey || '';
  const sel = $('#set-model');
  if (ai.settings.model && ![...sel.options].some((o) => o.value === ai.settings.model)) {
    const o = document.createElement('option');
    o.value = ai.settings.model; o.textContent = ai.settings.model;
    sel.appendChild(o);
  }
  sel.value = ai.settings.model || 'openrouter/auto';
  $('#set-status').textContent = '';
  settingsModal.showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', () => settingsModal.close());
$('#set-save').addEventListener('click', async () => {
  await ai.saveSettings({ apiKey: $('#set-key').value.trim(), model: $('#set-model').value });
  aiStatusRefresh();
  $('#set-status').textContent = '✓ Saved';
  toast('Settings saved', 'good');
});
$('#set-refresh-models').addEventListener('click', async () => {
  $('#set-status').textContent = 'Fetching models…';
  await ai.saveSettings({ apiKey: $('#set-key').value.trim(), model: $('#set-model').value });
  const models = await ai.listModels();
  if (!models.length) { $('#set-status').textContent = 'Could not fetch models (check key / network)'; return; }
  const sel = $('#set-model');
  const cur = sel.value;
  sel.innerHTML = '<option value="openrouter/auto">openrouter/auto (recommended)</option>';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.id;
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'openrouter/auto';
  $('#set-status').textContent = `✓ ${models.length} models loaded`;
});
$('#set-test').addEventListener('click', async () => {
  $('#set-status').textContent = 'Testing…';
  try {
    await ai.saveSettings({ apiKey: $('#set-key').value.trim(), model: $('#set-model').value });
    const r = await ai.chat([{ role: 'user', content: 'Reply with exactly: pong' }], { maxTokens: 10 });
    $('#set-status').textContent = `✓ Connected — model replied: "${r.slice(0, 40)}"`;
    aiStatusRefresh();
  } catch (e) {
    $('#set-status').textContent = `✗ ${e.message || e}`;
  }
});

// ───────────────────────── docs ─────────────────────────
$('#btn-docs').addEventListener('click', () => $('#docs-modal').showModal());
$('#docs-close').addEventListener('click', () => $('#docs-modal').close());

// ───────────────────────── keyboard shortcuts ─────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePause(); }
  else if (k === 'k') engine.killRandomInstance();
  else if (k === 'm') $('#chaos-monkey').click();
  else if (k === 'f') renderer.fit();
  else if (k === '1') { presetSel.value = 'simple-web'; applyPreset('simple-web'); }
  else if (k === '2') { presetSel.value = 'ecommerce'; applyPreset('ecommerce'); }
  else if (k === '3') { presetSel.value = 'event-pipeline'; applyPreset('event-pipeline'); }
  else if (k === '?') $('#docs-modal').showModal();
});

// ───────────────────────── main loop ─────────────────────────
let last = performance.now();
let uiAcc = 0;
function loop(now) {
  const dt = now - last;
  last = now;
  engine.tick(dt);
  renderer.frame(dt);
  uiAcc += dt;
  if (uiAcc > 500) { uiAcc = 0; updateStats(); drawCharts(); refreshGroupSelectorsIfChanged(); }
  requestAnimationFrame(loop);
}

let lastGroupSig = '';
function refreshGroupSelectorsIfChanged() {
  const sig = [...engine.groups.keys()].join(',');
  if (sig !== lastGroupSig) { lastGroupSig = sig; refreshGroupSelectors(); }
  updateScaleCount();
}

// ───────────────────────── boot ─────────────────────────
(async function boot() {
  await ai.loadSettings();
  aiStatusRefresh();
  applyPreset('ecommerce');
  engine.log('topology', 'info', 'Welcome to 16x SelfHeal 👋 — push the big red button and watch the system heal itself.');
  requestAnimationFrame(loop);
})();
