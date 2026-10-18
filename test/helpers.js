// Test isolation. Importing this file points the app at a unique THROWAWAY graph (devgraph_test_<random>).
// Tests never read or write your real graph. Cleanup drops ONLY that throwaway graph (name is verified first).
import { randomBytes } from 'node:crypto';
export const TEST_GRAPH = 'devgraph_test_' + randomBytes(4).toString('hex');
process.env.FALKOR_GRAPH = TEST_GRAPH;
process.env.FALKOR_CONNECT_TIMEOUT_MS ||= '2000';     // fail fast when no database is reachable
delete process.env.LLM_API_KEY;                       // deterministic evidence-only mode unless a test opts in

let connected = false;
export async function probe() {
  const { q, safeError } = await import('../src/db.js');
  try { await q('RETURN 1'); connected = true; return { up: true, skip: false }; }
  catch (e) { const reason = safeError(e);
    return { up: false, reason, skip: `FalkorDB unavailable (${reason}). Set FALKOR_URL or FALKOR_HOST/FALKOR_PORT (+ FALKOR_USERNAME/FALKOR_PASSWORD/FALKOR_TLS) in this shell to run live-database tests.` }; }
}
export async function loadFixtures() {   // TEST-ONLY data, written into the throwaway graph
  const { q, ensureSchema } = await import('../src/db.js'); const { loadFixtures } = await import('./fixtures.js');
  await ensureSchema(); await loadFixtures(q);
}
export async function cleanup() {
  const { getDb, closeDb, graphName } = await import('../src/db.js');
  if (connected) {
    if (graphName() !== TEST_GRAPH || !TEST_GRAPH.startsWith('devgraph_test_')) throw new Error('refusing to drop a non-test graph');
    const db = await getDb();
    try { await db.selectGraph(TEST_GRAPH).delete(); } catch {}
    try { const c = await db.connection; const keys = [];                 // rate-limit counters created by this run
      for await (const k of c.scanIterator({ MATCH: `rl:${TEST_GRAPH}:*`, COUNT: 100 })) keys.push(...[].concat(k));
      if (keys.length) await c.del(keys); } catch {}
  }
  await closeDb();
}
