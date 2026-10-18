import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchServices } from '../src/agent.js';
import { hashPw, verifyPw } from '../src/auth.js';
const all = ['auth-service', 'payment-service', 'session-cache'];
test('matches services by name, short name and alias', () => {
  assert.deepEqual(matchServices('what if the auth service fails', all), ['auth-service']);
  assert.deepEqual(matchServices('payment-service and session cache', all), ['payment-service', 'session-cache']);
});
test('no match returns empty (agent then reports insufficient evidence)', () => assert.deepEqual(matchServices('hello world', all), []));
test('password hashing verifies and rejects', () => { const h = hashPw('correct-horse-1'); assert.ok(verifyPw('correct-horse-1', h)); assert.ok(!verifyPw('wrong-password', h)); assert.ok(!verifyPw('x', 'garbage')); });
import { can } from '../src/auth.js';
test('role hierarchy', () => { assert.ok(can('admin', 'analyst')); assert.ok(can('analyst', 'viewer')); assert.ok(!can('viewer', 'analyst')); assert.ok(!can('viewer', 'admin')); assert.ok(!can(undefined, 'viewer')); });
import { classifyIntent, findContradictions, priority } from '../src/agent.js';
test('intent drives which tools are needed', () => {
  assert.deepEqual(Object.entries(classifyIntent('How does a connect to b?')).filter(([, v]) => v).map(([k]) => k), ['path']);
  assert.ok(classifyIntent('who owns payment-service?').expertise); assert.ok(classifyIntent('what happened before?').history);
  const all = classifyIntent('tell me about x'); assert.ok(all.impact && all.history && all.expertise && all.next);
});
test('contradictions are detected from stored records only', () => {
  const c = findContradictions([{ id: 'A', status: 'resolved', resolution: '' }, { id: 'B', status: 'investigating', resolver: 'dev' }, { id: 'C', status: 'open', resolution: 'fixed' }, { id: 'D', status: 'resolved', resolution: 'ok', resolver: 'x' }], [['s1', 's2', 's1']]);
  assert.deepEqual(c.map(x => x.ref), ['A', 'B', 'C', 's1>s2>s1']);
});
test('priority score is explainable and monotonic', () => {
  assert.equal(priority({}).label, 'low'); const p = priority({ downstream: 2, projects: 4, open: [{ severity: 'high' }] });
  assert.equal(p.score, 11); assert.equal(p.label, 'high'); assert.match(p.basis, /2 downstream/); assert.ok(priority({ downstream: 5, projects: 5, open: [{ severity: 'critical' }] }).score > p.score);
});
