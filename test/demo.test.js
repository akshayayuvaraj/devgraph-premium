// The demo scenario, verified against a real engine in a throwaway graph (seedDemo() is the same function the guarded CLI uses).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { probe, cleanup } from './helpers.js';
const db = await probe(); const opts = { skip: db.skip };
import { q, ensureSchema } from '../src/db.js';
import { seedDemo } from '../src/seed-demo.js';
import { runAgent } from '../src/agent.js';
import { createTask } from '../src/incidents.js';
import { getInvestigation } from '../src/tools.js';
if (db.up) await ensureSchema();
after(() => cleanup());
const count = async () => (await q('MATCH (n) RETURN count(n) AS n'))[0].n, edges = async () => (await q('MATCH ()-[r]->() RETURN count(r) AS n'))[0].n;
test('seed is idempotent and every node is labelled demo', opts, async () => {
  await seedDemo(q); const n = await count(), e = await edges(); await seedDemo(q); await seedDemo(q);
  assert.equal(await count(), n); assert.equal(await edges(), e); assert.equal((await q('MATCH (n) WHERE n.demo = true RETURN count(n) AS n'))[0].n, n);
});
test('every dependency endpoint is a real Service node (ids match across the graph)', opts, async () => {
  const bad = await q('MATCH (a:Service)-[:DEPENDS_ON]->(b) WHERE NOT b:Service RETURN a.id'); assert.equal(bad.length, 0);
  const [r] = await q('MATCH (:Service)-[r:DEPENDS_ON]->(:Service) RETURN count(r) AS n'); assert.ok(r.n >= 10);
});
test('judge flow: question -> traced paths -> evidence -> conflict/gap -> action -> recorded outcome -> recall', opts, async () => {
  const me = 'judge-1';
  const r = await runAgent('What breaks if payment-service fails, who has worked on it, and what happened before?', me);
  assert.equal(r.mode, 'evidence-only (no LLM configured)'); assert.equal(r.evidence.service, 'payment-service');
  assert.deepEqual([...r.evidence.dependencies.downstream].sort(), ['checkout-service', 'notification-service']);
  assert.deepEqual(r.evidence.dependencies.projects.map(p => p.project).sort(), ['Billing Engine', 'Customer Notifications', 'Merchant Portal', 'Web Storefront']);
  assert.ok(r.decision.evidence.some(e => e.type === 'direct') && r.decision.evidence.some(e => e.type === 'inferred'));
  assert.ok(r.decision.uncertainty.contradictions.some(c => /INC-225/.test(c.text)), 'resolved-without-resolution conflict');
  assert.ok(r.decision.uncertainty.gaps.some(g => /notification-service/.test(g)), 'missing owner reported');
  assert.equal(r.proposedAction.incidentId, 'INC-231'); assert.equal(r.proposedAction.developer, 'Marcus Cole'); assert.match(r.proposedAction.title, /INC-201/);
  assert.ok(r.evidence.incidents.linked.some(i => i.id === 'INC-208'), 'multi-hop RELATED_TO history');
  assert.equal(r.priority ?? r.decision.priority.label, 'high');
  const t = await createTask({ incidentId: 'INC-231', title: r.proposedAction.title, developer: 'Marcus Cole', investigationId: r.id }, { id: me });
  const inv = await getInvestigation(me, r.id); assert.ok(inv.tasks.some(x => x.id === t)); assert.match(inv.outcome, /task created/);
  const again = await runAgent('what breaks if payment-service fails?', me); assert.ok(again.decision.memory.read.some(m => m.id === r.id && m.influenced));
  assert.equal((await runAgent('what breaks if payment-service fails?', 'someone-else')).decision.memory.read.length, 0);
});
test('graph-driven expansion: with no incident on the target, upstream dependencies are checked and labelled as unconfirmed', opts, async () => {
  const r = await runAgent('What breaks if notification-service fails and what happened before?', 'judge-2');
  assert.ok(r.trace.some(t => /GRAPH-DRIVEN EXPANSION/.test(t.reason)));
  assert.ok(r.decision.evidence.some(e => e.type === 'inferred' && /upstream dependency/.test(e.claim)));
  assert.ok(r.decision.uncertainty.gaps.some(g => /possible causes only/.test(g)));
});
