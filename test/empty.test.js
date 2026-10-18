// Behaviour on a brand-new EMPTY graph (schema/indexes only, no data): no fabricated numbers, honest empty states.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { probe, cleanup } from './helpers.js';
const db = await probe(); const opts = { skip: db.skip };
import { ensureSchema } from '../src/db.js';
import * as A from '../src/auth.js';
import * as I from '../src/incidents.js';
const { default: app } = await import('../src/server.js');
let srv, base, tok;
before(async () => { if (!db.up) return; await ensureSchema();
  await new Promise(r => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; r(); }); });
  tok = await A.startSession(await A.register('empty@example.com', 'empty-password-1', 'admin')); });
after(async () => { srv?.close(); await cleanup(); });
const get = async (p, method = 'GET', body) => (await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'devgraph', cookie: `devgraph_sid=${tok}` }, body: body && JSON.stringify(body) })).json();
test('ensureSchema is idempotent and inserts no data', opts, async () => { await ensureSchema(); await ensureSchema(); });
test('overview reports real zeros, not placeholders', opts, async () => {
  const o = await get('/api/overview'); assert.equal(o.nodes, 0); assert.equal(o.edges, 0); assert.equal(o.components, 0);
  assert.deepEqual(o.topServices, []); assert.deepEqual(o.unresolved, []); assert.deepEqual(o.criticalChains, []);
});
test('graph, services and incidents are empty', opts, async () => {
  assert.deepEqual((await get('/api/graph')).nodes, []); assert.deepEqual(await get('/api/services'), []); assert.deepEqual(await get('/api/incidents'), []);
});
test('agent says there is no evidence and does not invent any', opts, async () => {
  const r = await get('/api/agent/query', 'POST', { question: 'what breaks if the payment service fails?' });
  assert.equal(r.mode, 'no-evidence'); assert.match(r.answer, /no services yet/); assert.equal(r.evidence, null);
});
test('incident creation requires an existing service', opts, async () => { await assert.rejects(() => I.createIncident({ title: 'Anything', severity: 'low', service: 'x' }), /unknown service/); });
