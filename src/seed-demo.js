
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const DEMO_GRAPH = 'devgraph-premium';

const services = [
  'api-gateway', 'auth-service', 'payment-service', 'checkout-service',
  'ledger-service', 'fraud-service', 'notification-service',
  'user-db', 'payments-db', 'session-cache'
];

const deps = [
  ['api-gateway', 'auth-service'],
  ['checkout-service', 'api-gateway'],
  ['checkout-service', 'payment-service'],
  ['payment-service', 'auth-service'],
  ['payment-service', 'ledger-service'],
  ['payment-service', 'fraud-service'],
  ['payment-service', 'payments-db'],
  ['ledger-service', 'payments-db'],
  ['auth-service', 'user-db'],
  ['auth-service', 'session-cache'],
  ['notification-service', 'payment-service'],
  ['fraud-service', 'user-db']
];

const projects = [
  ['Web Storefront', ['checkout-service']],
  ['Mobile App', ['api-gateway']],
  ['Billing Engine', ['payment-service', 'ledger-service']],
  ['Merchant Portal', ['api-gateway', 'payment-service']],
  ['Customer Notifications', ['notification-service']]
];

const devs = [
  ['Priya Nair', ['auth-service', 'session-cache'], ['Redis', 'OAuth']],
  ['Marcus Cole', ['payment-service', 'ledger-service'], ['Go', 'Postgres']],
  ['Lena Ortiz', ['api-gateway', 'checkout-service'], ['Envoy', 'Kubernetes']],
  ['Omar Hassan', ['user-db', 'payments-db'], ['Postgres']],
  ['Aisha Rahman', ['fraud-service'], ['Python', 'Kafka']]
];

const incidents = [
  ['INC-201', 'Payment authorization timeouts under peak load', 'high',
    'payment-service',
    'Raised auth call timeout to 3s and added retry with jittered backoff.',
    'Marcus Cole', '2026-07-09', 'resolved'],
  ['INC-208', 'Ledger double-posting after retry', 'critical',
    'ledger-service',
    'Added idempotency keys to ledger writes; backfilled 14 duplicate entries.',
    'Marcus Cole', '2026-08-02', 'resolved'],
  ['INC-214', 'Connection pool exhaustion on payments-db', 'high',
    'payments-db',
    'Increased pool size and added a slow-query alert.',
    'Omar Hassan', '2026-08-27', 'resolved'],
  ['INC-219', 'Auth token validation failures', 'critical',
    'auth-service',
    'Rotated expired signing key; added key-expiry monitor.',
    'Priya Nair', '2026-09-11', 'resolved'],
  ['INC-225', 'Elevated payment declines after fraud-rule change', 'medium',
    'payment-service', '', 'Aisha Rahman', '2026-09-30', 'resolved'],
  ['INC-231', 'Intermittent 5xx on payment capture', 'high',
    'payment-service', '', '', '2026-10-14', 'open'],
  ['INC-232', 'Gateway 502 bursts', 'medium',
    'api-gateway', '', 'Lena Ortiz', '2026-10-10', 'investigating']
];

const related = [
  ['INC-208', 'INC-201'],
  ['INC-214', 'INC-208'],
  ['INC-219', 'INC-201'],
  ['INC-231', 'INC-201'],
  ['INC-231', 'INC-214']
];

const tasks = [
  ['task-demo-1', 'Review gateway retry budget', 'INC-232',
    'Lena Ortiz', 'in_progress'],
  ['task-demo-2', 'Write runbook for declined-payment spikes', 'INC-225',
    'Aisha Rahman', 'open']
];

// Create a demo node only if no node with the same label and ID exists.
// Never overwrite an existing non-demo node.
async function createDemoNode(q, label, id, properties) {
  const existing = await q(
    `MATCH (n:${label} {id:$id}) RETURN n.demo AS demo LIMIT 1`,
    { id }
  );

  if (existing.length) {
    const isDemo =
      existing[0].demo === true || existing[0].demo === 'true';

    if (isDemo) return true;

    console.warn(`Skipping existing non-demo ${label}: ${id}`);
    return false;
  }

  const params = { id, ...properties };
  const assignments = Object.keys(properties)
    .map(key => `n.${key} = $${key}`)
    .concat('n.demo = true')
    .join(', ');

  await q(
    `CREATE (n:${label} {id:$id}) SET ${assignments}`,
    params
  );

  return true;
}

export async function seedDemo(q) {
  for (const id of services) {
    await createDemoNode(q, 'Service', id, { name: id });
  }

  for (const [id] of projects) {
    await createDemoNode(q, 'Project', id, { name: id });
  }

  for (const [id, , skills] of devs) {
    await createDemoNode(q, 'Developer', id, { name: id, skills });
  }

  for (const [
    id, title, severity, service, resolution, resolver, date, status
  ] of incidents) {
    const created = await createDemoNode(q, 'Incident', id, {
      name: id, title, severity, resolution, date, status
    });

    if (!created) continue;

    if (resolver) {
      await q(
        'MATCH (d:Developer {id:$dev}), (i:Incident {id:$id}) ' +
        'WHERE d.demo = true AND i.demo = true ' +
        'MERGE (d)-[:RESOLVED]->(i)',
        { dev: resolver, id }
      );
    }
  }

  for (const [id, title, incident, developer, status] of tasks) {
    const created = await createDemoNode(q, 'Task', id, {
      name: title,
      title,
      status,
      created: 1760000000000,
      createdBy: 'demo-seed'
    });

    if (!created) continue;

    await q(
      'MATCH (t:Task {id:$id}), (i:Incident {id:$incident}) ' +
      'WHERE t.demo = true AND i.demo = true ' +
      'MERGE (t)-[:FOR]->(i)',
      { id, incident }
    );

    await q(
      'MATCH (t:Task {id:$id}), (d:Developer {id:$developer}) ' +
      'WHERE t.demo = true AND d.demo = true ' +
      'MERGE (t)-[:ASSIGNED_TO]->(d)',
      { id, developer }
    );
  }

  for (const [a, b] of deps) {
    await q(
      'MATCH (a:Service {id:$a}), (b:Service {id:$b}) ' +
      'WHERE a.demo = true AND b.demo = true ' +
      'MERGE (a)-[:DEPENDS_ON]->(b)',
      { a, b }
    );
  }

  for (const [project, usedServices] of projects) {
    for (const service of usedServices) {
      await q(
        'MATCH (p:Project {id:$p}), (s:Service {id:$s}) ' +
        'WHERE p.demo = true AND s.demo = true ' +
        'MERGE (p)-[:USES]->(s)',
        { p: project, s: service }
      );
    }
  }

  for (const [developer, ownedServices] of devs) {
    for (const service of ownedServices) {
      await q(
        'MATCH (d:Developer {id:$d}), (s:Service {id:$s}) ' +
        'WHERE d.demo = true AND s.demo = true ' +
        'MERGE (d)-[:OWNS]->(s)',
        { d: developer, s: service }
      );
    }
  }

  for (const [id, , , service] of incidents) {
    await q(
      'MATCH (i:Incident {id:$id}), (s:Service {id:$service}) ' +
      'WHERE i.demo = true AND s.demo = true ' +
      'MERGE (i)-[:AFFECTS]->(s)',
      { id, service }
    );
  }

  for (const [a, b] of related) {
    await q(
      'MATCH (a:Incident {id:$a}), (b:Incident {id:$b}) ' +
      'WHERE a.demo = true AND b.demo = true ' +
      'MERGE (a)-[:RELATED_TO]->(b)',
      { a, b }
    );
  }
}

async function getDemoCounts(q) {
  return q(
    'MATCH (n) WHERE n.demo = true ' +
    'RETURN labels(n) AS labels, count(n) AS count'
  );
}

async function getRemainingDemoCount(q) {
  const result = await q(
    'MATCH (n) WHERE n.demo = true RETURN count(n) AS count'
  );

  return Number(result[0]?.count ?? 0);
}

// Preview is read-only. Applying cleanup requires --cleanup --apply.
export async function cleanupDemo(q, apply = false) {
  const counts = await getDemoCounts(q);

  // Find shared nodes BEFORE changing any labels or relationships.
  const shared = await q(
    'MATCH (n)-[r]-(m) ' +
    'WHERE n.demo = true ' +
    'AND (m.demo IS NULL OR m.demo <> true) ' +
    'RETURN DISTINCT labels(n) AS labels, n.id AS id'
  );

  console.log('Demo-labelled nodes by type:', counts);
  console.log('Demo nodes connected to non-demo records:', shared);

  if (!apply) {
    console.log('PREVIEW ONLY. Nothing was changed.');
    console.log('Review the results, then use --cleanup --apply if appropriate.');
    return;
  }

  // Step 1: Unmark shared nodes FIRST.
  // They remain in the graph, including their existing relationships
  // to other real records and to other shared nodes.
  for (const row of shared) {
    if (row.id == null) {
      throw new Error(
        'A shared demo node has no ID. Aborting cleanup for safety.'
      );
    }

    await q(
      'MATCH (n {id:$id}) WHERE n.demo = true REMOVE n.demo',
      { id: row.id }
    );
  }

  // Step 2: Delete relationships only between nodes that are STILL demo.
  // Relationships between preserved shared nodes are not deleted.
  await q(
    'MATCH (a)-[r]-(b) ' +
    'WHERE a.demo = true AND b.demo = true DELETE r'
  );

  // Step 3: Delete the remaining demo nodes.
  // DETACH DELETE removes only relationships attached to those nodes.
  await q(
    'MATCH (n) WHERE n.demo = true DETACH DELETE n'
  );

  // Step 4: Verify the actual remaining marker count.
  const remaining = await getRemainingDemoCount(q);
  const remainingByType = await getDemoCounts(q);

  console.log('Remaining demo-labelled nodes:', remaining);
  console.log('Remaining demo nodes by type:', remainingByType);

  if (remaining !== 0) {
    throw new Error(
      `Cleanup verification failed: ${remaining} demo-labelled nodes remain.`
    );
  }

  console.log('Cleanup completed and verified.');
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const {
    graphName, q, ensureSchema, closeDb, safeError, connectionSummary
  } = await import('./db.js');

  try {
    const name = graphName();

    if (name !== DEMO_GRAPH) {
      throw new Error(
        `Refusing to run on graph "${name}". Expected "${DEMO_GRAPH}".`
      );
    }

    console.log('Graph:', name);
    console.log('Connection:', connectionSummary());

    if (process.argv.includes('--cleanup')) {
      await cleanupDemo(q, process.argv.includes('--apply'));
    } else {
      await ensureSchema();
      await seedDemo(q);

      const count = await getRemainingDemoCount(q);
      console.log('Demo-labelled nodes:', count);
    }
  } catch (error) {
    console.error('Operation failed:', safeError(error));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
