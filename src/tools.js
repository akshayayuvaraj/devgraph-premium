
import { q } from './db.js';

// Allowlisted, parameterized graph tools.
// Graph data is shared across authenticated users.
// Investigation memory is shared for reading.
// The owner field remains for attribution and owner-only deletion.

const unique = (values) => [...new Set(
  (Array.isArray(values) ? values : []).filter(Boolean)
)];

export async function listServices() {
  const rows = await q(
    'MATCH (s:Service) RETURN s.id AS id ORDER BY id'
  );

  return rows.map((row) => row.id).filter(Boolean);
}

export async function findServiceDependencies(service) {
  if (!service) {
    return {
      tool: 'find_service_dependencies',
      service: null,
      downstream: [],
      upstream: [],
      chains: [],
      projects: [],
    };
  }

  const chainRows = await q(
    `MATCH p=(d:Service)-[:DEPENDS_ON*1..4]->(f:Service {id:$s})
     RETURN [x IN nodes(p) | x.id] AS chain
     LIMIT 25`,
    { s: service }
  );

  const chains = chainRows
    .map((row) => row.chain)
    .filter((chain) => Array.isArray(chain) && chain.length > 1);

  const downstream = unique(chains.map((chain) => chain[0]));

  const projectRows = await q(
    `MATCH (p:Project)-[:USES]->(s:Service)
     WHERE s.id IN $names
     RETURN p.id AS project, collect(DISTINCT s.id) AS via
     ORDER BY project`,
    { names: unique([service, ...downstream]) }
  );

  const upstreamRows = await q(
    `MATCH p=(f:Service {id:$s})-[:DEPENDS_ON*1..4]->(u:Service)
     RETURN DISTINCT u.id AS service
     ORDER BY service`,
    { s: service }
  );

  return {
    tool: 'find_service_dependencies',
    service,
    downstream,
    upstream: unique(upstreamRows.map((row) => row.service)),
    chains,
    projects: projectRows,
  };
}

export async function findRelatedIncidents(services) {
  const names = unique(services);

  if (names.length === 0) {
    return {
      tool: 'find_related_incidents',
      direct: [],
      linked: [],
    };
  }

  const direct = await q(
    `MATCH (i:Incident)-[:AFFECTS]->(s:Service)
     WHERE s.id IN $names
     OPTIONAL MATCH (d:Developer)-[:RESOLVED]->(i)
     RETURN
       i.id AS id,
       i.title AS title,
       i.severity AS severity,
       coalesce(i.status, 'resolved') AS status,
       i.date AS date,
       i.resolution AS resolution,
       s.id AS service,
       d.id AS resolver
     ORDER BY i.date DESC
     LIMIT 25`,
    { names }
  );

  const directIds = unique(direct.map((row) => row.id));

  const linked = await q(
    `MATCH (i:Incident)-[:AFFECTS]->(s:Service)
     WHERE s.id IN $names
     MATCH (i)-[:RELATED_TO*1..2]-(o:Incident)
     WHERE NOT o.id IN $ids
     OPTIONAL MATCH (o)-[:AFFECTS]->(os:Service)
     OPTIONAL MATCH (d:Developer)-[:RESOLVED]->(o)
     RETURN
       o.id AS id,
       o.title AS title,
       o.severity AS severity,
       coalesce(o.status, 'resolved') AS status,
       o.date AS date,
       o.resolution AS resolution,
       os.id AS service,
       d.id AS resolver,
       collect(DISTINCT i.id) AS via
     ORDER BY date DESC
     LIMIT 20`,
    { names, ids: directIds }
  );

  return {
    tool: 'find_related_incidents',
    direct,
    linked,
  };
}

export async function findDeveloperExpertise(services) {
  const names = unique(services);

  if (names.length === 0) {
    return {
      tool: 'find_developer_expertise',
      developers: [],
      scoring:
        'score = 2 per owned service + 1 per resolved incident on the affected services',
    };
  }

  const rows = await q(
    `MATCH (d:Developer)
     OPTIONAL MATCH (d)-[:OWNS]->(o:Service)
     WHERE o.id IN $names
     WITH d, collect(DISTINCT o.id) AS owns
     OPTIONAL MATCH (d)-[:RESOLVED]->(i:Incident)-[:AFFECTS]->(s:Service)
     WHERE s.id IN $names
     WITH d, owns, collect(DISTINCT i.id) AS resolved
     WITH d, owns, resolved,
          size(owns) * 2 + size(resolved) AS score
     WHERE score > 0
     RETURN
       d.id AS developer,
       d.skills AS skills,
       owns,
       resolved,
       score
     ORDER BY score DESC, developer
     LIMIT 5`,
    { names }
  );

  return {
    tool: 'find_developer_expertise',
    developers: rows,
    scoring:
      'score = 2 per owned service + 1 per resolved incident on the affected services',
  };
}

export async function ownersOf(services) {
  const names = unique(services);

  if (names.length === 0) {
    return {};
  }

  const rows = await q(
    `MATCH (s:Service)
     WHERE s.id IN $names
     OPTIONAL MATCH (d:Developer)-[:OWNS]->(s)
     RETURN s.id AS service, collect(DISTINCT d.id) AS owners
     ORDER BY service`,
    { names }
  );

  return Object.fromEntries(
    rows.map((row) => [
      row.service,
      (row.owners || []).filter(Boolean),
    ])
  );
}

// FalkorDB shortestPath supports directed traversal.
// Try both directions to find a path between the requested nodes.
export async function traceRelationshipPath(a, b) {
  if (!a || !b) {
    return {
      tool: 'trace_relationship_path',
      paths: [],
      note: 'Both node IDs are required.',
    };
  }

  const cypher = `
    MATCH (x {id:$a}), (y {id:$b})
    WITH shortestPath((x)-[*..6]->(y)) AS p
    RETURN
      [n IN nodes(p) | n.id] AS nodes,
      [e IN relationships(p) | type(e)] AS rels
  `;

  const paths = [];

  for (const [from, to, direction] of [
    [a, b, 'forward'],
    [b, a, 'reverse'],
  ]) {
    const rows = await q(cypher, { a: from, b: to });
    const path = rows[0];

    if (path?.nodes) {
      paths.push({
        nodes: path.nodes,
        rels: path.rels || [],
        direction,
      });
    }
  }

  return {
    tool: 'trace_relationship_path',
    paths,
    note: 'Directed shortest paths, maximum 6 hops; both directions tried.',
  };
}

// ---------------------------------------------------------------------
// Shared investigation memory
//
// All authenticated users can read relevant investigations and traces.
// owner is retained for attribution and creator-only deletion.
// Authentication and authorization must be enforced by the API routes.
// ---------------------------------------------------------------------

export const recallMemory = (owner, names) => {
  // owner is required as a signal that this request has an authenticated user.
  if (!owner) {
    return Promise.resolve([]);
  }

  const serviceNames = unique(names);

  if (serviceNames.length === 0) {
    return Promise.resolve([]);
  }

  return q(
    `MATCH (m:Investigation)-[:ABOUT]->(s:Service)
     WHERE s.id IN $names
     RETURN DISTINCT
       m.id AS id,
       m.question AS question,
       m.summary AS summary,
       m.ts AS ts,
       m.primary AS primary,
       m.snapshot AS snapshot,
       m.recommendation AS recommendation,
       m.lesson AS lesson,
       coalesce(m.stale, false) AS stale,
       coalesce(m.outcome, 'none') AS outcome
     ORDER BY m.ts DESC
     LIMIT 5`,
    { names: serviceNames }
  );
};

export async function saveMemory(owner, m) {
  if (!owner || !m?.id || !m?.question) {
    throw new Error(
      'saveMemory requires an authenticated owner, memory ID, and question.'
    );
  }

  await q(
    `CREATE (n:Investigation {
       id:$id,
       owner:$o,
       question:$question,
       summary:$summary,
       ts:$ts,
       kind:'episodic',
       primary:$primary,
       snapshot:$snapshot,
       recommendation:$recommendation,
       lesson:$lesson,
       llm:$llm,
       decision:$decision,
       outcome:'none',
       stale:false
     })`,
    {
      id: m.id,
      o: owner,
      question: m.question,
      summary: m.summary || '',
      ts: Date.now(),
      primary: m.primary || '',
      snapshot: m.snapshot || '',
      recommendation: m.recommendation || '',
      lesson: m.lesson || '',
      llm: Boolean(m.llm),
      decision: m.decision || '',
    }
  );

  for (const service of unique(m.services)) {
    await q(
      `MATCH (m:Investigation {id:$id, owner:$o}),
             (s:Service {id:$s})
       MERGE (m)-[:ABOUT]->(s)`,
      {
        id: m.id,
        o: owner,
        s: service,
      }
    );
  }
}

export const supersede = (owner, id, primary, snapshot) => {
  if (!owner || !id) {
    return Promise.resolve([]);
  }

  return q(
    `MATCH (old:Investigation {primary:$p})
     WHERE old.id <> $id
       AND coalesce(old.stale, false) = false
       AND old.snapshot <> $snap
     MATCH (n:Investigation {id:$id, owner:$o})
     SET old.stale = true
     MERGE (n)-[:SUPERSEDES]->(old)
     RETURN old.id AS id`,
    {
      o: owner,
      p: primary,
      id,
      snap: snapshot,
    }
  ).then((rows) => rows.map((row) => row.id));
};

export const listMemories = (owner) => {
  if (!owner) {
    return Promise.resolve([]);
  }

  return q(
    `MATCH (m:Investigation)
     RETURN
       m.id AS id,
       m.question AS question,
       m.summary AS summary,
       m.ts AS ts,
       m.primary AS primary,
       coalesce(m.stale, false) AS stale,
       coalesce(m.outcome, 'none') AS outcome,
       m.lesson AS lesson,
       m.owner AS owner
     ORDER BY m.ts DESC
     LIMIT 50`
  );
};

// Shared read does not imply shared delete.
// Only the creator can delete their investigation.
export const deleteMemory = (owner, id) => {
  if (!owner || !id) {
    return Promise.resolve([]);
  }

  return q(
    `MATCH (m:Investigation {id:$id, owner:$o})
     DETACH DELETE m`,
    { id, o: owner }
  );
};

export async function getInvestigation(owner, id) {
  if (!owner || !id) {
    return null;
  }

  const rows = await q(
    `MATCH (m:Investigation {id:$id})
     RETURN
       m.id AS id,
       m.question AS question,
       m.summary AS summary,
       m.ts AS ts,
       m.decision AS decision,
       coalesce(m.stale, false) AS stale,
       coalesce(m.outcome, 'none') AS outcome,
       m.recommendation AS recommendation,
       m.owner AS owner`,
    { id }
  );

  if (rows.length === 0) {
    return null;
  }

  const taskRows = await q(
    `MATCH (t:Task)-[:FROM_INVESTIGATION]->(m:Investigation {id:$id})
     OPTIONAL MATCH (t)-[:FOR]->(i:Incident)
     OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(d:Developer)
     RETURN
       t.id AS id,
       t.title AS title,
       t.status AS status,
       t.created AS created,
       i.id AS incident,
       d.id AS developer
     ORDER BY t.created DESC`,
    { id }
  );

  let decision = null;

  try {
    if (rows[0].decision) {
      decision = JSON.parse(rows[0].decision);
    }
  } catch {
    decision = rows[0].decision ?? null;
  }

  return {
    ...rows[0],
    decision,
    tasks: taskRows,
  };
}
