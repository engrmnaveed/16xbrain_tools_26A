/**
 * Topology presets. Coordinates are world-space; the renderer auto-fits.
 * Columns: client=80, lb=280, gateway=460, services=680, deps=920+.
 */

export const PRESETS = {
  'simple-web': {
    name: 'Simple Web App',
    description: 'Client → Load Balancer → 3× web servers → Redis cache + Postgres (primary + replica).',
    build(engine) {
      const client = engine.addGroup({ name: 'internet', type: 'client', replicas: 1, x: 80, y: 300, autoheal: false });
      const lb = engine.addGroup({ name: 'load-balancer', type: 'lb', replicas: 1, x: 300, y: 300, capacity: 200, baseLatency: 5, autoheal: false });
      const web = engine.addGroup({ name: 'web', type: 'service', replicas: 3, x: 560, y: 200, capacity: 22, baseLatency: 45 });
      const cache = engine.addGroup({ name: 'redis-cache', type: 'cache', replicas: 1, x: 830, y: 170, capacity: 80, baseLatency: 8, cacheHitRate: 0.7 });
      const db = engine.addGroup({ name: 'postgres', type: 'db', replicas: 2, x: 830, y: 340, capacity: 35, baseLatency: 70 });
      engine.connectGroups(client.id, lb.id);
      engine.connectGroups(lb.id, web.id);
      engine.connectGroups(web.id, cache.id);
      engine.connectGroups(web.id, db.id);
    },
  },

  'ecommerce': {
    name: 'E-commerce Microservices',
    description: 'API gateway fronting auth, catalog, orders & payments services with shared cache, databases and an order queue.',
    build(engine) {
      const client = engine.addGroup({ name: 'internet', type: 'client', replicas: 1, x: 60, y: 360, autoheal: false });
      const lb = engine.addGroup({ name: 'load-balancer', type: 'lb', replicas: 1, x: 250, y: 360, capacity: 300, baseLatency: 4, autoheal: false });
      const gw = engine.addGroup({ name: 'api-gateway', type: 'gateway', replicas: 2, x: 430, y: 320, capacity: 90, baseLatency: 12 });
      const auth = engine.addGroup({ name: 'auth', type: 'service', replicas: 2, x: 660, y: 80, capacity: 25, baseLatency: 35 });
      const catalog = engine.addGroup({ name: 'catalog', type: 'service', replicas: 2, x: 660, y: 280, capacity: 25, baseLatency: 40 });
      const orders = engine.addGroup({ name: 'orders', type: 'service', replicas: 2, x: 660, y: 480, capacity: 20, baseLatency: 55 });
      const payments = engine.addGroup({ name: 'payments', type: 'service', replicas: 2, x: 660, y: 660, capacity: 18, baseLatency: 80 });
      const cache = engine.addGroup({ name: 'redis-cache', type: 'cache', replicas: 1, x: 940, y: 170, capacity: 100, baseLatency: 6, cacheHitRate: 0.75 });
      const pgMain = engine.addGroup({ name: 'postgres-main', type: 'db', replicas: 2, x: 940, y: 360, capacity: 40, baseLatency: 65 });
      const queue = engine.addGroup({ name: 'order-queue', type: 'queue', replicas: 1, x: 940, y: 560, capacity: 120, baseLatency: 10 });
      const pgPay = engine.addGroup({ name: 'postgres-payments', type: 'db', replicas: 2, x: 940, y: 700, capacity: 30, baseLatency: 70 });
      engine.connectGroups(client.id, lb.id);
      engine.connectGroups(lb.id, gw.id);
      engine.connectGroups(gw.id, auth.id);
      engine.connectGroups(gw.id, catalog.id);
      engine.connectGroups(gw.id, orders.id);
      engine.connectGroups(gw.id, payments.id);
      engine.connectGroups(auth.id, cache.id);
      engine.connectGroups(catalog.id, cache.id);
      engine.connectGroups(catalog.id, pgMain.id);
      engine.connectGroups(orders.id, queue.id);
      engine.connectGroups(orders.id, pgMain.id);
      engine.connectGroups(payments.id, pgPay.id);
    },
  },

  'event-pipeline': {
    name: 'Event-Driven Pipeline',
    description: 'Ingest tier pushing to a message queue consumed by a worker pool writing to a time-series store.',
    build(engine) {
      const client = engine.addGroup({ name: 'producers', type: 'client', replicas: 1, x: 70, y: 300, autoheal: false });
      const lb = engine.addGroup({ name: 'load-balancer', type: 'lb', replicas: 1, x: 260, y: 300, capacity: 300, baseLatency: 4, autoheal: false });
      const ingest = engine.addGroup({ name: 'ingest', type: 'service', replicas: 2, x: 470, y: 260, capacity: 40, baseLatency: 20 });
      const queue = engine.addGroup({ name: 'kafka', type: 'queue', replicas: 1, x: 690, y: 300, capacity: 200, baseLatency: 8 });
      const workers = engine.addGroup({ name: 'workers', type: 'service', replicas: 3, x: 900, y: 200, capacity: 18, baseLatency: 90 });
      const tsdb = engine.addGroup({ name: 'timescale-db', type: 'db', replicas: 2, x: 1130, y: 300, capacity: 45, baseLatency: 50 });
      engine.connectGroups(client.id, lb.id);
      engine.connectGroups(lb.id, ingest.id);
      engine.connectGroups(ingest.id, queue.id);
      engine.connectGroups(queue.id, workers.id);
      engine.connectGroups(workers.id, tsdb.id);
    },
  },
};

export function loadPreset(engine, key) {
  const p = PRESETS[key];
  if (!p) return false;
  engine.reset();
  p.build(engine);
  engine.log('topology', 'info', `Topology loaded: ${p.name}`);
  return true;
}
