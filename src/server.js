import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { q, getDb, graphName, ensureSchema, connectionSummary, safeError } from './db.js';
import { runAgent, probeLLM } from './agent.js';
import { listMemories, deleteMemory, getInvestigation } from './tools.js';
import * as A from './auth.js';
import * as I from './incidents.js';


// Absolute filesystem path of ./public. (new URL(...).pathname breaks on Windows: it yields '/C:/Users/My%20Name/...')
export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);  // set when behind a reverse proxy so req.ip is the client
app.use(express.json({ limit: '10kb' }));
app.use((_, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src blob:; frame-ancestors 'none'" }); next(); });
app.use(express.static(PUBLIC_DIR));
// CSRF: SameSite=Strict cookie + required custom header on all mutating requests.
app.use('/api', (req, res, next) => (req.method !== 'GET' && req.get('x-requested-with') !== 'devgraph') ? res.status(403).json({ error: 'missing CSRF header' }) : next());

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error('[api]', safeError(e)); res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error. Check that FalkorDB is reachable (see the server log).' }); });

// Rate limiting: counters live in FalkorDB's Redis layer (shared across instances, survive restarts); falls back to memory if unavailable.
const mem = new Map();
async function limit(key, max, windowSec = 60) {
  try {
    const c = await (await getDb()).connection, k = `rl:${graphName()}:${key}`, n = await c.incr(k);
    if (n === 1) await c.expire(k, windowSec);
    if (n > max) throw bad('rate limited', 429);
  } catch (e) {
    if (e.status) throw e;
    const now = Date.now(), a = (mem.get(key) || []).filter(t => now - t < windowSec * 1000);
    if (a.length >= max) throw bad('rate limited', 429); a.push(now); mem.set(key, a);
  }
}
const guard = (min, h) => wrap(async (req, res) => {
  const u = await A.userFromToken(A.cookieOf(req)); if (!u) throw bad('authentication required', 401);
  if (!A.can(u.role, min)) throw bad('insufficient role', 403);
  req.user = u; return h(req, res);
});
const need = (b) => { if (b?.confirm !== true) throw bad('confirmation required', 409); };
const creds = (b) => { const email = String(b?.email || '').trim().toLowerCase(), pw = String(b?.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) throw bad('valid email required'); if (pw.length < 10 || pw.length > 200) throw bad('password must be 10-200 chars'); return [email, pw]; };
const newPw = (p) => { p = String(p || ''); if (p.length < 10 || p.length > 200) throw bad('password must be 10-200 chars'); return p; };

// ---- auth
app.get('/api/auth/status', wrap(async (req, res) => { const u = await A.userFromToken(A.cookieOf(req));
  res.json({ user: u && { email: u.email, role: u.role }, setupRequired: (await A.userCount()) === 0, signupOpen: process.env.ALLOW_SIGNUP === 'true' }); }));
app.post('/api/auth/register', wrap(async (req, res) => { await limit('reg:' + req.ip, 10); const [email, pw] = creds(req.body);
  const first = (await A.userCount()) === 0;
  if (!first && process.env.ALLOW_SIGNUP !== 'true') throw bad('signup is closed', 403);   // first user = safe setup; no default admin
  const id = await A.register(email, pw, first ? 'admin' : 'viewer'); await A.audit(id, first ? 'setup:first-admin' : 'signup', email);
  res.set('Set-Cookie', A.cookieHeader(await A.startSession(id))).json({ user: { email, role: first ? 'admin' : 'viewer' } }); }));
app.post('/api/auth/login', wrap(async (req, res) => { const [email, pw] = creds(req.body);
  await limit('login:' + req.ip, 10); await limit('loginacct:' + email, 10, 300);   // per-IP and per-account throttling
  const id = await A.login(email, pw); await A.purgeExpiredSessions(); await A.audit(id, 'login');
  res.set('Set-Cookie', A.cookieHeader(await A.startSession(id))).json({ ok: true }); }));
app.post('/api/auth/logout', wrap(async (req, res) => { await A.endSession(A.cookieOf(req)); res.set('Set-Cookie', A.cookieHeader('', 0)).status(204).end(); }));
app.post('/api/auth/password', guard('viewer', async (req, res) => { await limit('pw:' + req.user.id, 5, 300);
  await A.changePassword(req.user.id, String(req.body?.current || ''), newPw(req.body?.next)); await A.audit(req.user.id, 'password:change');
  res.set('Set-Cookie', A.cookieHeader('', 0)).json({ ok: true, note: 'all sessions revoked; sign in again' }); }));

// ---- admin: users, roles, password reset, audit
app.get('/api/admin/users', guard('admin', async (_r, res) => res.json(await A.listUsers())));
app.post('/api/admin/users', guard('admin', async (req, res) => { const [email, pw] = creds(req.body); const role = String(req.body?.role || 'viewer');
  const id = await A.register(email, pw, role); await A.audit(req.user.id, 'user:create', `${email} (${role})`); res.status(201).json({ id }); }));
app.post('/api/admin/users/:id/password', guard('admin', async (req, res) => { need(req.body);
  await A.setPassword(req.params.id, newPw(req.body?.password)); await A.audit(req.user.id, 'user:password-reset', req.params.id); res.json({ ok: true }); }));
app.get('/api/audit', guard('admin', async (_r, res) => res.json(await A.listAudit())));

// ---- read endpoints
app.get('/api/health', wrap(async (_, res) => { const r = await q('MATCH (n) RETURN count(n) AS nodes'); res.json({ ok: true, nodes: r[0].nodes }); }));
app.get('/api/settings/status', guard('viewer', async (req, res) => res.json({ user: req.user.email, role: req.user.role, database: 'connected',
  llm: process.env.LLM_API_KEY ? 'configured (not verified; admins can run a connection test)' : 'not configured (evidence-only mode)', graph: graphName(), connection: (c => c.local ? 'local' : c.tls ? 'remote (TLS)' : 'remote (NO TLS)')(connectionSummary()), signup: process.env.ALLOW_SIGNUP === 'true' ? 'open (viewer role)' : 'closed' })));
const DOMAIN = 'NOT n:User AND NOT n:Session AND NOT n:Audit AND NOT n:Investigation';
app.get('/api/overview', guard('viewer', async (req, res) => {
  const [c] = await q(`MATCH (n) WHERE ${DOMAIN} RETURN count(n) AS nodes`), [e] = await q('MATCH (a)-[r]->(b) WHERE NOT a:User AND NOT a:Session AND NOT a:Audit RETURN count(r) AS edges');
  const [inv] = await q('MATCH (m:Investigation {owner:$o}) RETURN count(m) AS n', { o: req.user.id });
  res.json({ nodes: c.nodes, edges: e.edges, investigations: inv.n,
    topServices: await q('MATCH (s:Service)<-[r:DEPENDS_ON|USES|AFFECTS]-() RETURN s.id AS service, count(r) AS connections ORDER BY connections DESC LIMIT 5'),
    criticalChains: (await q('MATCH p=(a:Service)-[:DEPENDS_ON*2..4]->(b:Service) RETURN [x IN nodes(p) | x.id] AS chain, size(nodes(p)) AS len ORDER BY len DESC LIMIT 4')).map(r => r.chain),
    unresolved: (await I.listIncidents()).filter(i => i.status !== 'resolved'), recentIncidents: (await I.listIncidents()).slice(0, 5),
    components: (await q('MATCH (s:Service) RETURN count(s) AS n'))[0].n, demoNodes: (await q('MATCH (n) WHERE n.demo = true RETURN count(n) AS n'))[0].n,
    openTasks: (await I.listAllTasks()).filter(t => t.status !== 'done').slice(0, 6), graph: graphName(), recentInvestigations: await q('MATCH (m:Investigation {owner:$o}) RETURN m.question AS question, m.ts AS ts ORDER BY m.ts DESC LIMIT 5', { o: req.user.id }) });  }));
app.get('/api/graph', guard('viewer', async (_r, res) => {
  const rows = await q(`MATCH (a)-[r]->(b) WHERE ${DOMAIN.replace(/n:/g, 'a:')} AND NOT b:Investigation AND NOT b:User AND NOT b:Session AND NOT b:Audit RETURN a.id AS s, labels(a)[0] AS sl, type(r) AS t, b.id AS d, labels(b)[0] AS dl LIMIT 500`);
  const nodes = new Map(); rows.forEach(r => { nodes.set(r.s, r.sl); nodes.set(r.d, r.dl); });
  res.json({ nodes: [...nodes].map(([id, label]) => ({ id, label })), edges: rows.map(r => ({ from: r.s, to: r.d, label: r.t })) }); }));
app.get('/api/graph/nodes/:id', guard('viewer', async (req, res) => {
  const id = String(req.params.id).slice(0, 80);
  const rows = await q('MATCH (n {id:$id}) WHERE NOT n:User AND NOT n:Session AND NOT n:Audit OPTIONAL MATCH (n)-[r]-(o) RETURN labels(n)[0] AS label, n.title AS title, n.severity AS severity, n.resolution AS resolution, type(r) AS rel, startNode(r).id = n.id AS outgoing, o.id AS other', { id });
  if (!rows.length) throw bad('not found', 404);
  res.json({ id, label: rows[0].label, title: rows[0].title, severity: rows[0].severity, resolution: rows[0].resolution, relations: rows.filter(r => r.rel).map(r => ({ rel: r.rel, outgoing: r.outgoing, other: r.other })) }); }));
app.get('/api/services', guard('viewer', async (_r, res) => res.json((await q('MATCH (s:Service) RETURN s.id AS id ORDER BY id')).map(r => r.id))));
app.get('/api/developers', guard('viewer', async (_r, res) => res.json(await I.listDevelopers())));

// ---- incidents & tasks (analyst+ to write; confirmation required)
app.get('/api/incidents', guard('viewer', async (req, res) => res.json(await I.listIncidents({ search: String(req.query.search || ''), severity: String(req.query.severity || ''), status: String(req.query.status || '') }))));
app.post('/api/incidents', guard('analyst', async (req, res) => { need(req.body); await limit('w:' + req.user.id, 30);
  const id = await I.createIncident(req.body); await A.audit(req.user.id, 'incident:create', id); res.status(201).json({ id }); }));
app.patch('/api/incidents/:id', guard('analyst', async (req, res) => { need(req.body); await limit('w:' + req.user.id, 30);
  const changed = await I.updateIncident(req.params.id, req.body); await A.audit(req.user.id, 'incident:update', `${req.params.id} [${changed}]`); res.json({ ok: true, changed }); }));
app.get('/api/incidents/:id/tasks', guard('viewer', async (req, res) => res.json(await I.listTasks(req.params.id))));
app.get('/api/tasks', guard('viewer', async (req, res) => res.json(await I.listAllTasks({ status: String(req.query.status || '') }))));
app.post('/api/tasks', guard('analyst', async (req, res) => { need(req.body); await limit('w:' + req.user.id, 30);
  const id = await I.createTask(req.body, req.user); await A.audit(req.user.id, 'task:create', `${id}${req.body.investigationId ? ' from investigation ' + req.body.investigationId : ''}`); res.status(201).json({ id }); }));
app.patch('/api/tasks/:id', guard('analyst', async (req, res) => { need(req.body); await I.updateTask(req.params.id, req.body); await A.audit(req.user.id, 'task:update', `${req.params.id} -> ${req.body.status}`); res.json({ ok: true }); }));
app.get('/api/investigations', guard('viewer', async (req, res) => res.json(await listMemories(req.user.id))));
app.get('/api/investigations/:id', guard('viewer', async (req, res) => { const r = await getInvestigation(req.user.id, String(req.params.id).slice(0, 64)); if (!r) throw bad('not found', 404); res.json(r); }));
app.post('/api/settings/llm-check', guard('admin', async (req, res) => { await limit('llmcheck:' + req.user.id, 5); res.json(await probeLLM()); }));

// ---- agent & memory
app.post('/api/agent/query', guard('viewer', async (req, res) => { await limit('q:' + req.user.id, 20);
  const question = String(req.body?.question || '').trim(); if (question.length < 3 || question.length > 500) throw bad('question must be 3-500 chars');
  const readOnly = req.body?.readOnly === true;
  res.json(await runAgent(question, req.user.id, { readOnly })); }));
app.get('/api/memories', guard('viewer', async (req, res) => res.json(await listMemories(req.user.id))));
app.delete('/api/memories/:id', guard('viewer', async (req, res) => { await deleteMemory(req.user.id, req.params.id); await A.audit(req.user.id, 'memory:delete', req.params.id); res.status(204).end(); }));

export default app;
// Start only when run directly (cross-platform check; comparing URL.pathname to argv[1] fails on Windows).
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  ensureSchema().catch(e => console.warn('[db] schema check skipped:', safeError(e)));   // indexes only; server still starts if the DB is down
  app.listen(process.env.PORT || 8080, () => console.log('DevGraph on http://localhost:' + (process.env.PORT || 8080)));
}
