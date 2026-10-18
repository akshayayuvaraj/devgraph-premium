// Prepares an EMPTY graph (indexes only). Inserts no data and deletes nothing.
import { ensureSchema, graphName, connectionSummary, closeDb, safeError, q } from './db.js';
try {
  const c = connectionSummary();
  console.log(`Connecting (${c.local ? 'local' : 'remote'}, TLS: ${c.tls ? 'yes' : 'no'}, authenticated: ${c.authenticated ? 'yes' : 'no'}), graph "${graphName()}"`);
  await ensureSchema();
  const [n] = await q('MATCH (n) RETURN count(n) AS nodes');
  console.log(`Schema ready (indexes only). Nodes currently in graph: ${n.nodes}. No data was inserted or removed.`);
} catch (e) { console.error('init failed:', safeError(e)); process.exitCode = 1; }
await closeDb();
