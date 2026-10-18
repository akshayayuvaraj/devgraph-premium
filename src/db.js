import { FalkorDB } from 'falkordb';

const GRAPH_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LABELS = ['Service', 'Project', 'Developer', 'Incident', 'Investigation', 'User', 'Session', 'Task'];   // fixed allowlist (used in index DDL)

// This project owns ONLY its own graph. Graphs belonging to the original project are refused outright.
export const DEFAULT_GRAPH = 'devgraph-premium';
export const PROTECTED_GRAPHS = ['devgraph', 'devgraph-test'];
export function graphName(env = process.env) {
  const n = env.FALKOR_GRAPH || DEFAULT_GRAPH;
  if (!GRAPH_RE.test(n)) throw new Error('FALKOR_GRAPH must match [A-Za-z0-9_-]{1,64}');
  if (PROTECTED_GRAPHS.includes(n)) throw new Error(`FALKOR_GRAPH "${n}" belongs to another project and is protected; use "${DEFAULT_GRAPH}"`);
  return n;
}

// Builds client options from environment variables. Supports:
//   FALKOR_URL=falkors://user:pass@host:port      (TLS; also rediss://)  or  falkor:// / redis:// (no TLS)
//   FALKOR_HOST, FALKOR_PORT, FALKOR_USERNAME, FALKOR_PASSWORD, FALKOR_TLS=true   (local or FalkorDB Cloud)
// Returns only non-secret information in `summary`.
export function dbConfig(env = process.env) {
  const connectTimeout = Math.max(500, +(env.FALKOR_CONNECT_TIMEOUT_MS || 5000));
  const reconnectStrategy = (retries) => (retries >= 3 ? new Error('gave up after 3 reconnect attempts') : Math.min((retries + 1) * 250, 1000));
  let options, host, tls, auth;
  if (env.FALKOR_URL) {
    let u;
    try { u = new URL(env.FALKOR_URL); } catch { throw new Error('FALKOR_URL is not a valid URL (percent-encode special characters in the password, or use FALKOR_PASSWORD)'); }
    if (!/^(falkors?|rediss?):$/.test(u.protocol)) throw new Error('FALKOR_URL must start with falkors://, falkor://, rediss:// or redis://');
    tls = u.protocol === 'falkors:' || u.protocol === 'rediss:'; host = u.hostname; auth = !!(u.username || u.password);
    options = { url: env.FALKOR_URL, socket: { connectTimeout, reconnectStrategy } };
  } else {
    host = env.FALKOR_HOST || 'localhost'; tls = /^(1|true|yes)$/i.test(env.FALKOR_TLS || '');
    const port = +(env.FALKOR_PORT || 6379);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FALKOR_PORT must be a valid port number');
    auth = !!env.FALKOR_PASSWORD;
    options = { socket: { host, port, tls, connectTimeout, reconnectStrategy },
      ...(env.FALKOR_USERNAME && { username: env.FALKOR_USERNAME }), ...(env.FALKOR_PASSWORD && { password: env.FALKOR_PASSWORD }) };
  }
  const local = LOCAL_HOSTS.has(host);
  return { options, summary: { local, tls, authenticated: auth },
    warnings: !local && !tls ? ['Remote FalkorDB without TLS: credentials and data travel unencrypted. Use falkors:// or FALKOR_TLS=true.'] : [] };
}
export const connectionSummary = () => dbConfig().summary;

// Error text with anything credential-like removed (URL userinfo and the configured password).
export function safeError(e, env = process.env) {
  let m = String(e?.message || e);
  m = m.replace(/\/\/[^@\s/]*@/g, '//***@');
  for (const secret of [env.FALKOR_PASSWORD, env.FALKOR_URL && (() => { try { return new URL(env.FALKOR_URL).password; } catch { return ''; } })()])
    if (secret && secret.length > 2) m = m.split(secret).join('***');
  return m;
}

// The FalkorDB client creates its EventEmitter internally and re-emits socket errors on it BEFORE connect() returns, so no listener
// can be attached in time; an unhandled 'error' event then crashes the process (e.g. wrong host, missing TLS). Log it safely instead.
if (!FalkorDB.prototype.__safeErrors) {
  const emit = FalkorDB.prototype.emit;
  FalkorDB.prototype.emit = function (ev, ...args) {
    if (ev === 'error' && this.listenerCount('error') === 0) { lastConnError = safeError(args[0]); console.error('[db] connection error:', lastConnError); return false; }
    return emit.call(this, ev, ...args);
  };
  FalkorDB.prototype.__safeErrors = true;
}
let dbp, graph, warned = false, lastConnError = '';
export function getDb() {
  if (!dbp) {
    const { options, warnings } = dbConfig();
    if (!warned) { warnings.forEach(w => console.warn('[db] ' + w)); warned = true; }
    dbp = FalkorDB.connect(options)
      .then(db => { db.on('error', e => console.error('[db] connection error:', safeError(e))); return db; })
      .catch(e => { dbp = null; const m = /gave up/.test(String(e?.message)) && lastConnError ? lastConnError : safeError(e); throw new Error('FalkorDB connection failed: ' + m + (/WRONGPASS|NOAUTH|certificate/i.test(m) ? '' : ' (check FALKOR_HOST/FALKOR_PORT/FALKOR_URL, credentials and TLS settings)')); });
  }
  return dbp;
}
export async function getGraph() { return (graph ??= (await getDb()).selectGraph(graphName())); }
// All queries are parameterized; user text is never concatenated into Cypher.
export async function q(cypher, params = {}) {
  try { const r = await (await getGraph()).query(cypher, { params }); return r.data ?? []; }
  catch (e) { if (/closed|ECONN|socket/i.test(String(e?.message))) { dbp = null; graph = null; } throw e; }   // reconnect on the next call
}
export async function closeDb() { const p = dbp; dbp = null; graph = null; if (p) { try { await (await p).close(); } catch {} } }

// Creates indexes only. Inserts NO data. Safe to run repeatedly.
export async function ensureSchema() {
  for (const l of LABELS) {
    try { await q(`CREATE INDEX FOR (n:${l}) ON (n.id)`); }
    catch (e) { if (!/already|exist|indexed/i.test(String(e?.message))) throw e; }
  }
}
