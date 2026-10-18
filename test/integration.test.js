// Live-database tests. Run against an isolated throwaway graph; skipped (with a reason) when FalkorDB is unreachable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_GRAPH, probe, loadFixtures, cleanup } from './helpers.js';
const db = await probe();
const opts = { skip: db.skip };
if (db.up) await loadFixtures();
import { q } from '../src/db.js';
import * as T from '../src/tools.js';
after(() => cleanup());
test('multi-hop dependency impact for auth-service', opts, async () => {
  const d = await T.findServiceDependencies('auth-service');
  for (const s of ['api-gateway', 'payment-service', 'checkout-service']) assert.ok(d.downstream.includes(s), s);
  assert.ok(d.projects.some(p => p.project === 'Web Storefront'));
});
test('related incidents and expertise', opts, async () => {
  const i = await T.findRelatedIncidents(['auth-service']); assert.ok(i.direct.some(x => x.id === 'INC-101'));
  const e = await T.findDeveloperExpertise(['auth-service']); assert.equal(e.developers[0].developer, 'Priya Nair');
});
test('memory is tenant-isolated and deletable', opts, async () => {
  await T.saveMemory('tenantA', { id: 'm-test-1', question: 'q', summary: 's', primary: 'auth-service', snapshot: '{}', decision: '{}', services: ['auth-service'] });
  assert.equal((await T.recallMemory('tenantB', ['auth-service'])).filter(m => m.id === 'm-test-1').length, 0);
  assert.equal((await T.recallMemory('tenantA', ['auth-service'])).filter(m => m.id === 'm-test-1').length, 1);
  await T.deleteMemory('tenantA', 'm-test-1');
  assert.equal((await T.recallMemory('tenantA', ['auth-service'])).filter(m => m.id === 'm-test-1').length, 0);
});
test('unknown service yields no downstream', opts, async () => assert.deepEqual((await T.findServiceDependencies('nope')).downstream, []));
import * as I from '../src/incidents.js';
import * as A from '../src/auth.js';
test('incident create/update/search + validation', opts, async () => {
  const id = await I.createIncident({ title: 'Test incident', severity: 'low', service: 'user-db' });
  assert.match(id, /^INC-\d+$/);
  assert.deepEqual(await I.updateIncident(id, { status: 'resolved', resolution: 'fixed' }), ['status', 'resolution']);
  assert.ok((await I.listIncidents({ search: 'test incident' })).some(i => i.id === id && i.status === 'resolved'));
  await assert.rejects(() => I.createIncident({ title: 'x', severity: 'low', service: 'user-db' }), /title/);
  await assert.rejects(() => I.createIncident({ title: 'Valid title', severity: 'nope', service: 'user-db' }), /severity/);
  await assert.rejects(() => I.createIncident({ title: 'Valid title', severity: 'low', service: 'ghost' }), /unknown service/);
  await assert.rejects(() => I.updateIncident('INC-999999', { status: 'open' }), /not found/);
  await q('MATCH (i:Incident {id:$id}) DETACH DELETE i', { id });
});
test('roles, password reset revokes sessions', opts, async () => {
  const email = `t${Date.now()}@example.com`, id = await A.register(email, 'first-password-1', 'analyst');
  const tok = await A.startSession(id); assert.equal((await A.userFromToken(tok)).role, 'analyst');
  await A.setPassword(id, 'second-password-2'); assert.equal(await A.userFromToken(tok), null);
  assert.equal(await A.login(email, 'second-password-2'), id);
  await assert.rejects(() => A.login(email, 'first-password-1'), /invalid/);
  await q('MATCH (u:User {id:$id}) DETACH DELETE u', { id });
});
