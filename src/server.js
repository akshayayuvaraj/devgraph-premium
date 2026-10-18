
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  q,
  getDb,
  graphName,
  ensureSchema,
  connectionSummary,
  safeError
} from './db.js';
import { runAgent, probeLLM } from './agent.js';
import {
  listMemories,
  deleteMemory,
  getInvestigation
} from './tools.js';
import * as A from './auth.js';
import * as I from './incidents.js';

// Absolute filesystem path of ./public.
export const PUBLIC_DIR = fileURLToPath(
  new URL('../public/', import.meta.url)
);

const app = express();

app.disable('x-powered-by');

if (process.env.TRUST_PROXY) {
  app.set(
    'trust proxy',
    process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY
  );
}

app.use(express.json({ limit: '10kb' }));

// Security headers
app.use((_, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src blob:; frame-ancestors 'none'"
  });

  next();
});

app.use(express.static(PUBLIC_DIR));

// CSRF protection for mutating requests
app.use('/api', (req, res, next) => {
  if (
    req.method !== 'GET' &&
    req.get('x-requested-with') !== 'devgraph'
  ) {
    return res.status(403).json({ error: 'missing CSRF header' });
  }

  next();
});

const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error('[api]', safeError(error));

    res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : 'Internal error. Check that FalkorDB is reachable (see the server log).'
    });
  });

// Rate limiting: use FalkorDB Redis when available, otherwise memory.
const mem = new Map();

async function limit(key, max, windowSec = 60) {
  try {
    const connection = (await getDb()).connection;
    const redisKey = `rl:${graphName()}:${key}`;
    const count = await connection.incr(redisKey);

    if (count === 1) {
      await connection.expire(redisKey, windowSec);
    }

    if (count > max) {
      throw bad('rate limited', 429);
    }
  } catch (error) {
    if (error.status) throw error;

    const now = Date.now();
    const attempts = (mem.get(key) || []).filter(
      (timestamp) => now - timestamp < windowSec * 1000
    );

    if (attempts.length >= max) {
      throw bad('rate limited', 429);
    }

    attempts.push(now);
    mem.set(key, attempts);
  }
}

const guard = (minimumRole, handler) =>
  wrap(async (req, res) => {
    const user = await A.userFromToken(A.cookieOf(req));

    if (!user) {
      throw bad('authentication required', 401);
    }

    if (!A.can(user.role, minimumRole)) {
      throw bad('insufficient role', 403);
    }

    req.user = user;
    return handler(req, res);
  });

const need = (body) => {
  if (body?.confirm !== true) {
    throw bad('confirmation required', 409);
  }
};

const creds = (body) => {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) {
    throw bad('valid email required');
  }

  if (password.length < 10 || password.length > 200) {
    throw bad('password must be 10-200 chars');
  }

  return [email, password];
};

const newPw = (password) => {
  const value = String(password || '');

  if (value.length < 10 || value.length > 200) {
    throw bad('password must be 10-200 chars');
  }

  return value;
};

// ---- Authentication

app.get('/api/auth/status', wrap(async (req, res) => {
  const user = await A.userFromToken(A.cookieOf(req));
  const setupRequired = (await A.userCount()) === 0;

  return res.json({
    user: user
      ? { email: user.email, role: user.role }
      : null,
    setupRequired,
    signupOpen: process.env.ALLOW_SIGNUP === 'true'
  });
}));

app.post('/api/auth/register', wrap(async (req, res) => {
  await limit('reg:' + req.ip, 10);

  const [email, password] = creds(req.body);
  const first = (await A.userCount()) === 0;

  if (!first && process.env.ALLOW_SIGNUP !== 'true') {
    throw bad('signup is closed', 403);
  }

  // First registered user becomes admin; later public signups are viewers.
  const role = first ? 'admin' : 'viewer';
  const id = await A.register(email, password, role);

  await A.audit(
    id,
    first ? 'setup:first-admin' : 'signup',
    email
  );

  const token = await A.startSession(id);

  res
    .set('Set-Cookie', A.cookieHeader(token))
    .json({ user: { email, role } });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const [email, password] = creds(req.body);

  await limit('login:' + req.ip, 10);
  await limit('loginacct:' + email, 10, 300);

  const id = await A.login(email, password);

  await A.purgeExpiredSessions();
  await A.audit(id, 'login');

  res
    .set('Set-Cookie', A.cookieHeader(await A.startSession(id)))
    .json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await A.endSession(A.cookieOf(req));

  res
    .set('Set-Cookie', A.cookieHeader('', 0))
    .status(204)
    .end();
}));

app.post('/api/auth/password', guard('viewer', async (req, res) => {
  await limit('pw:' + req.user.id, 5, 300);

  await A.changePassword(
    req.user.id,
    String(req.body?.current || ''),
    newPw(req.body?.next)
  );

  await A.audit(req.user.id, 'password:change');

  res
    .set('Set-Cookie', A.cookieHeader('', 0))
    .json({
      ok: true,
      note: 'all sessions revoked; sign in again'
    });
}));

// ---- Admin: users, roles, password reset, audit

app.get('/api/admin/users', guard('admin', async (_req, res) => {
  res.json(await A.listUsers());
}));

app.post('/api/admin/users', guard('admin', async (req, res) => {
  const [email, password] = creds(req.body);
  const role = String(req.body?.role || 'viewer');

  const id = await A.register(email, password, role);

  await A.audit(req.user.id, 'user:create', `${email} (${role})`);

  res.status(201).json({ id });
}));

app.post('/api/admin/users/:id/password', guard('admin', async (req, res) => {
  need(req.body);

  await A.setPassword(req.params.id, newPw(req.body?.password));
  await A.audit(req.user.id, 'user:password-reset', req.params.id);

  res.json({ ok: true });
}));

app.get('/api/audit', guard('admin', async (_req, res) => {
  res.json(await A.listAudit());
}));

// ---- Read endpoints

app.get('/api/health', wrap(async (_req, res) => {
  const rows = await q('MATCH (n) RETURN count(n) AS nodes');

  res.json({ ok: true, nodes: rows[0].nodes });
}));

app.get('/api/settings/status', guard('viewer', async (req, res) => {
  const connection = connectionSummary();

  res.json({
    user: req.user.email,
    role: req.user.role,
    database: 'connected',
    llm: process.env.LLM_API_KEY
      ? 'configured (not verified; admins can run a connection test)'
      : 'not configured (evidence-only mode)',
    graph: graphName(),
    connection: connection.local
      ? 'local'
      : connection.tls
        ? 'remote (TLS)'
        : 'remote (NO TLS)',
    signup: process.env.ALLOW_SIGNUP === 'true'
      ? 'open (viewer role)'
      : 'closed'
  });
}));

const DOMAIN =
  'NOT n:User AND NOT n:Session AND NOT n:Audit AND NOT n:Investigation';

app.get('/api/overview', guard('viewer', async (req, res) => {
  const [counts] = await q(
    `MATCH (n) WHERE ${DOMAIN} RETURN count(n) AS nodes`
  );

  const [edgeCounts] = await q(
    'MATCH (a)-[r]->(b) WHERE NOT a:User AND NOT a:Session AND NOT a:Audit RETURN count(r) AS edges'
  );

  const [investigationCounts] = await q(
    'MATCH (m:Investigation {owner:$o}) RETURN count(m) AS n',
    { o: req.user.id }
  );

  const incidents = await I.listIncidents();

  res.json({
    nodes: counts.nodes,
    edges: edgeCounts.edges,
    investigations: investigationCounts.n,

    topServices: await q(
      'MATCH (s:Service)<-[r:DEPENDS_ON|USES|AFFECTS]-() RETURN s.id AS service, count(r) AS connections ORDER BY connections DESC LIMIT 5'
    ),

    criticalChains: (
      await q(
        'MATCH p=(a:Service)-[:DEPENDS_ON*2..4]->(b:Service) RETURN [x IN nodes(p) | x.id] AS chain, size(nodes(p)) AS len ORDER BY len DESC LIMIT 4'
      )
    ).map((row) => row.chain),

    unresolved: incidents.filter((incident) => incident.status !== 'resolved'),
    recentIncidents: incidents.slice(0, 5),

    components: (
      await q('MATCH (s:Service) RETURN count(s) AS n')
    )[0].n,

    demoNodes: (
      await q('MATCH (n) WHERE n.demo = true RETURN count(n) AS n')
    )[0].n,

    openTasks: (
      await I.listAllTasks()
    ).filter((task) => task.status !== 'done').slice(0, 6),

    graph: graphName(),

    recentInvestigations: await q(
      'MATCH (m:Investigation {owner:$o}) RETURN m.question AS question, m.ts AS ts ORDER BY m.ts DESC LIMIT 5',
      { o: req.user.id }
    )
  });
}));

app.get('/api/graph', guard('viewer', async (_req, res) => {
  const rows = await q(
    `MATCH (a)-[r]->(b) WHERE ${DOMAIN.replace(/n:/g, 'a:')} AND NOT b:Investigation AND NOT b:User AND NOT b:Session AND NOT b:Audit RETURN a.id AS s, labels(a)[0] AS sl, type(r) AS t, b.id AS d, labels(b)[0] AS dl LIMIT 500`
  );

  const nodes = new Map();

  rows.forEach((row) => {
    nodes.set(row.s, row.sl);
    nodes.set(row.d, row.dl);
  });

  res.json({
    nodes: [...nodes].map(([id, label]) => ({ id, label })),
    edges: rows.map((row) => ({
      from: row.s,
      to: row.d,
      label: row.t
    }))
  });
}));

app.get('/api/graph/nodes/:id', guard('viewer', async (req, res) => {
  const id = String(req.params.id).slice(0, 80);

  const rows = await q(
    'MATCH (n {id:$id}) WHERE NOT n:User AND NOT n:Session AND NOT n:Audit OPTIONAL MATCH (n)-[r]-(o) RETURN labels(n)[0] AS label, n.title AS title, n.severity AS severity, n.resolution AS resolution, type(r) AS rel, startNode(r).id = n.id AS outgoing, o.id AS other',
    { id }
  );

  if (!rows.length) {
    throw bad('not found', 404);
  }

  res.json({
    id,
    label: rows[0].label,
    title: rows[0].title,
    severity: rows[0].severity,
    resolution: rows[0].resolution,
    relations: rows
      .filter((row) => row.rel)
      .map((row) => ({
        rel: row.rel,
        outgoing: row.outgoing,
        other: row.other
      }))
  });
}));

app.get('/api/services', guard('viewer', async (_req, res) => {
  const rows = await q(
    'MATCH (s:Service) RETURN s.id AS id ORDER BY id'
  );

  res.json(rows.map((row) => row.id));
}));

app.get('/api/developers', guard('viewer', async (_req, res) => {
  res.json(await I.listDevelopers());
}));

// ---- Incidents and tasks

app.get('/api/incidents', guard('viewer', async (req, res) => {
  res.json(
    await I.listIncidents({
      search: String(req.query.search || ''),
      severity: String(req.query.severity || ''),
      status: String(req.query.status || '')
    })
  );
}));

app.post('/api/incidents', guard('analyst', async (req, res) => {
  need(req.body);
  await limit('w:' + req.user.id, 30);

  const id = await I.createIncident(req.body);

  await A.audit(req.user.id, 'incident:create', id);

  res.status(201).json({ id });
}));

app.patch('/api/incidents/:id', guard('analyst', async (req, res) => {
  need(req.body);
  await limit('w:' + req.user.id, 30);

  const changed = await I.updateIncident(req.params.id, req.body);

  await A.audit(
    req.user.id,
    'incident:update',
    `${req.params.id} [${changed}]`
  );

  res.json({ ok: true, changed });
}));

app.get('/api/incidents/:id/tasks', guard('viewer', async (req, res) => {
  res.json(await I.listTasks(req.params.id));
}));

app.get('/api/tasks', guard('viewer', async (req, res) => {
  res.json(
    await I.listAllTasks({
      status: String(req.query.status || '')
    })
  );
}));

app.post('/api/tasks', guard('analyst', async (req, res) => {
  need(req.body);

  const id = await I.createTask(req.body, req.user);

  await A.audit(
    req.user.id,
    'task:create',
    `${id}${req.body.investigationId
      ? ' from investigation ' + req.body.investigationId
      : ''}`
  );

  res.status(201).json({ id });
}));

app.patch('/api/tasks/:id', guard('analyst', async (req, res) => {
  need(req.body);

  await I.updateTask(req.params.id, req.body);

  await A.audit(
    req.user.id,
    'task:update',
    `${req.params.id} -> ${req.body.status}`
  );

  res.json({ ok: true });
}));

app.get('/api/investigations', guard('viewer', async (req, res) => {
  res.json(await listMemories(req.user.id));
}));

app.get('/api/investigations/:id', guard('viewer', async (req, res) => {
  const result = await getInvestigation(
    req.user.id,
    String(req.params.id).slice(0, 64)
  );

  if (!result) {
    throw bad('not found', 404);
  }

  res.json(result);
}));

app.post('/api/settings/llm-check', guard('admin', async (req, res) => {
  await limit('llmcheck:' + req.user.id, 5);
  res.json(await probeLLM());
}));

// ---- Agent and memory

app.post('/api/agent/query', guard('viewer', async (req, res) => {
  await limit('q:' + req.user.id, 20);

  const question = String(req.body?.question || '').trim();

  if (question.length < 3 || question.length > 500) {
    throw bad('question must be 3-500 chars');
  }

  const readOnly = req.body?.readOnly === true;

  res.json(
    await runAgent(question, req.user.id, { readOnly })
  );
}));

app.get('/api/memories', guard('viewer', async (req, res) => {
  res.json(await listMemories(req.user.id));
}));

app.delete('/api/memories/:id', guard('viewer', async (req, res) => {
  await deleteMemory(req.user.id, req.params.id);

  await A.audit(req.user.id, 'memory:delete', req.params.id);

  res.status(204).end();
}));

export default app;

// Start only when run directly.
const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  ensureSchema().catch((error) => {
    console.warn('[db] schema check skipped:', safeError(error));
  });

  app.listen(process.env.PORT || 8080, () => {
    console.log(
      'DevGraph on http://localhost:' + (process.env.PORT || 8080)
    );
  });
}
