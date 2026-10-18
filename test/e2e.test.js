
 // Full flow over HTTP against an isolated throwaway graph.
 // Skipped (with a reason) when FalkorDB is unreachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_GRAPH, probe, loadFixtures, cleanup } from './helpers.js';

const db = await probe();
const opts = { skip: db.skip };

if (db.up) await loadFixtures();

import * as A from '../src/auth.js';
const { default: app } = await import('../src/server.js');

let srv, base;
const users = {};

before(async () => {
  if (!db.up) return;

  await new Promise((resolve) => {
    srv = app.listen(0, () => {
      base = 'http://localhost:' + srv.address().port;
      resolve();
    });
  });

  for (const role of ['viewer', 'analyst']) {
    const id = await A.register(
      `e2e-${role}-${Date.now()}@example.com`,
      'e2e-password-123',
      role
    );

    users[role] = {
      id,
      tok: await A.startSession(id),
    };
  }
});

after(async () => {
  srv?.close();
  await cleanup();
});

const call = (who, method, path, body) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'devgraph',
      cookie: `devgraph_sid=${users[who].tok}`,
    },
    body: body && JSON.stringify(body),
  });

test('viewer cannot write; analyst needs confirmation', opts, async () => {
  const inc = {
    title: 'E2E incident',
    severity: 'low',
    service: 'user-db',
    confirm: true,
  };

  assert.equal(
    (await call('viewer', 'POST', '/api/incidents', inc)).status,
    403
  );

  assert.equal(
    (
      await call('analyst', 'POST', '/api/incidents', {
        ...inc,
        confirm: undefined,
      })
    ).status,
    409
  );

  assert.equal(
    (await call('analyst', 'POST', '/api/incidents', inc)).status,
    201
  );

  assert.equal(
    (await call('viewer', 'GET', '/api/admin/users')).status,
    403
  );
});

test('agent answer is grounded in graph results, with path + provenance', opts, async () => {
  const response = await call('analyst', 'POST', '/api/agent/query', {
    question:
      'If the auth service fails, which projects are affected and who has experience?',
  });

  const r = await response.json();

  assert.equal(r.mode, 'evidence-only (no LLM configured)');

  const d = r.evidence.dependencies;

  for (const service of [
    'api-gateway',
    'payment-service',
    'checkout-service',
  ]) {
    assert.ok(d.downstream.includes(service), service);
  }

  assert.ok(d.projects.some((p) => p.project === 'Web Storefront'));
  assert.equal(r.evidence.expertise.developers[0].developer, 'Priya Nair');
  assert.ok(r.highlight.includes('INC-101'));
  assert.match(r.answer, /Priya Nair/);
  assert.ok(r.id);
});

test('read-only agent query does not create investigation memory', opts, async () => {
  const beforeResponse = await call(
    'analyst',
    'GET',
    '/api/memories'
  );

  const beforeMemories = await beforeResponse.json();

  const response = await call('analyst', 'POST', '/api/agent/query', {
    question: 'If the auth service fails, which projects are affected?',
    readOnly: true,
  });

  assert.equal(response.status, 200);

  const result = await response.json();

  assert.equal(
    result.decision.memory.write,
    null,
    'read-only query should not report a memory write'
  );

  assert.match(
    result.decision.memory.writeSkippedReason,
    /read-only/i
  );

  assert.ok(
    result.trace.some((step) => step.step === 'skip_memory_write'),
    'trace should record that memory writing was skipped'
  );

  const afterResponse = await call(
    'analyst',
    'GET',
    '/api/memories'
  );

  const afterMemories = await afterResponse.json();

  assert.equal(
    afterMemories.length,
    beforeMemories.length,
    'read-only query must not create investigation memory'
  );
});

test('memory persists, is recalled, and does not leak across users', opts, async () => {
  const again = await (
    await call('analyst', 'POST', '/api/agent/query', {
      question: 'auth service failing: what now?',
    })
  ).json();

  assert.ok(
    again.evidence.memory.length >= 1,
    'analyst recalls earlier investigation'
  );

  const other = await (
    await call('viewer', 'POST', '/api/agent/query', {
      question: 'auth service failing: what now?',
    })
  ).json();

  assert.equal(
    other.evidence.memory.length,
    0,
    'viewer sees none of the analyst memories'
  );

  const mem = await (
    await call('analyst', 'GET', '/api/memories')
  ).json();

  assert.ok(mem.length >= 2);

  assert.equal(
    (
      await call('viewer', 'DELETE', '/api/memories/' + mem[0].id)
    ).status,
    204
  );

  assert.ok(
    (
      await (await call('analyst', 'GET', '/api/memories')).json()
    ).some((m) => m.id === mem[0].id),
    'foreign delete must not remove it'
  );
});

test('shortest path between two services is traced', opts, async () => {
  const r = await (
    await call('viewer', 'POST', '/api/agent/query', {
      question: 'How does checkout-service connect to user-db?',
    })
  ).json();

  assert.ok(
    r.trace.some(
      (t) => t.step === 'trace_relationship_path' && t.rows >= 1
    ),
    JSON.stringify(r.trace)
  );

  assert.equal(
    r.evidence.service,
    'checkout-service',
    'service named first is the subject'
  );

  assert.ok(r.evidence.path.paths[0].nodes.includes('checkout-service'));
  assert.match(r.answer.split('\n')[0], /^Path: checkout-service -> /);
});

test(
  'the graph drives the proposed action: highest-severity open incident, assigned from ownership edges',
  opts,
  async () => {
    const r = await (
      await call('viewer', 'POST', '/api/agent/query', {
        question: 'What should we investigate first for api-gateway?',
      })
    ).json();

    assert.equal(r.proposedAction.incidentId, 'INC-140');
    assert.equal(r.proposedAction.developer, 'Lena Ortiz');
    assert.equal(r.proposedAction.requiresConfirmation, true);

    assert.ok(
      r.proposedAction.evidence.every((id) =>
        r.decision.evidence.some((e) => e.id === id)
      ),
      'action cites real evidence ids'
    );

    assert.match(
      r.answer,
      /proposed only; nothing changes until you confirm/
    );
  }
);

test('actions need confirmation, validate everything first, and record provenance', opts, async () => {
  const q1 = await (
    await call('analyst', 'POST', '/api/agent/query', {
      question: 'What should we investigate first for api-gateway?',
    })
  ).json();

  const body = {
    incidentId: 'INC-140',
    title: 'Check gateway retries',
    developer: 'Lena Ortiz',
    investigationId: q1.id,
  };

  assert.equal(
    (await call('analyst', 'POST', '/api/tasks', body)).status,
    409
  );

  assert.equal(
    (
      await call('viewer', 'POST', '/api/tasks', {
        ...body,
        confirm: true,
      })
    ).status,
    403
  );

  assert.equal(
    (
      await call('analyst', 'POST', '/api/tasks', {
        ...body,
        developer: 'Nobody',
        confirm: true,
      })
    ).status,
    400
  );

  const before = (
    await (await call('analyst', 'GET', '/api/tasks')).json()
  ).length;

  assert.equal(
    (
      await call('analyst', 'POST', '/api/tasks', {
        ...body,
        investigationId: 'not-mine',
        confirm: true,
      })
    ).status,
    404
  );

  assert.equal(
    (
      await (await call('analyst', 'GET', '/api/tasks')).json()
    ).length,
    before,
    'failed actions must not create tasks'
  );

  const ok = await call('analyst', 'POST', '/api/tasks', {
    ...body,
    confirm: true,
  });

  assert.equal(ok.status, 201);

  const { id } = await ok.json();

  const inv = await (
    await call('analyst', 'GET', '/api/investigations/' + q1.id)
  ).json();

  assert.ok(
    inv.tasks.some((task) => task.id === id && task.developer === 'Lena Ortiz')
  );

  assert.match(inv.outcome, /task created/);
  assert.ok(
    inv.decision.tools.length > 0,
    'stored decision trace is retrievable'
  );

  assert.equal(
    (await call('viewer', 'GET', '/api/investigations/' + q1.id)).status,
    404,
    'other users cannot read it'
  );

  assert.equal(
    (
      await call('analyst', 'PATCH', '/api/tasks/' + id, {
        status: 'done',
        confirm: true,
      })
    ).status,
    200
  );

  assert.equal(
    (
      await call('analyst', 'PATCH', '/api/tasks/' + id, {
        status: 'bogus',
        confirm: true,
      })
    ).status,
    400
  );
});

test('stale memory: changed graph is detected on recall and the old investigation is marked stale', opts, async () => {
  const first = await (
    await call('analyst', 'POST', '/api/agent/query', {
      question:
        'What breaks if api-gateway fails and what should we do first?',
    })
  ).json();

  assert.equal(
    (
      await call('analyst', 'PATCH', '/api/incidents/INC-140', {
        status: 'resolved',
        resolution: 'fixed in test',
        confirm: true,
      })
    ).status,
    200
  );

  const second = await (
    await call('analyst', 'POST', '/api/agent/query', {
      question:
        'What breaks if api-gateway fails and what should we do first?',
    })
  ).json();

  assert.ok(
    second.decision.memory.delta.some(
      (d) => /no longer open/.test(d) && /INC-140/.test(d)
    ),
    JSON.stringify(second.decision.memory.delta)
  );

  assert.ok(
    second.decision.memory.read.some(
      (m) => m.id === first.id && m.influenced
    )
  );

  assert.deepEqual(
    second.decision.memory.write.supersedes.includes(first.id),
    true
  );

  const memories = await (
    await call('analyst', 'GET', '/api/memories')
  ).json();

  assert.equal(
    memories.find((m) => m.id === first.id).stale,
    true
  );

  assert.equal(
    second.proposedAction,
    null,
    'no open incident left, so no write action is proposed'
  );
});

test('no matching evidence is stated honestly', opts, async () => {
  const r = await (
    await call('viewer', 'POST', '/api/agent/query', {
      question: 'tell me about the moon base',
    })
  ).json();

  assert.equal(r.mode, 'no-evidence');
  assert.match(r.answer, /insufficient evidence/);
});

test('overview, graph and node inspector return live data without leaking auth nodes', opts, async () => {
  const o = await (
    await call('viewer', 'GET', '/api/overview')
  ).json();

  assert.ok(
    o.nodes >= 20 &&
      o.edges > 0 &&
      o.criticalChains.length > 0 &&
      o.unresolved.length >= 1
  );

  const g = await (
    await call('viewer', 'GET', '/api/graph')
  ).json();

  assert.ok(
    g.nodes.length >= 15 &&
      !g.nodes.some((n) =>
        ['User', 'Session', 'Audit', 'Investigation'].includes(n.label)
      )
  );

  const n = await (
    await call('viewer', 'GET', '/api/graph/nodes/auth-service')
  ).json();

  assert.ok(n.relations.some((r) => r.rel === 'DEPENDS_ON'));
});
