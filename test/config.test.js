// Pure unit tests (no database): connection config, TLS/auth options, credential redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbConfig, graphName, safeError } from '../src/db.js';
test('defaults to local, unauthenticated, no TLS', () => {
  const c = dbConfig({}); assert.equal(c.options.socket.host, 'localhost'); assert.equal(c.options.socket.port, 6379);
  assert.deepEqual(c.summary, { local: true, tls: false, authenticated: false }); assert.deepEqual(c.warnings, []);
});
test('FalkorDB Cloud via host/port + username/password + TLS', () => {
  const c = dbConfig({ FALKOR_HOST: 'x.cloud.falkordb.com', FALKOR_PORT: '12345', FALKOR_USERNAME: 'default', FALKOR_PASSWORD: 'p@ss/w:rd', FALKOR_TLS: 'true' });
  assert.equal(c.options.socket.tls, true); assert.equal(c.options.username, 'default'); assert.equal(c.options.password, 'p@ss/w:rd');
  assert.deepEqual(c.summary, { local: false, tls: true, authenticated: true }); assert.deepEqual(c.warnings, []);
});
test('FALKOR_URL: falkors:// and rediss:// imply TLS; falkor:// does not', () => {
  assert.equal(dbConfig({ FALKOR_URL: 'falkors://u:p@h.example.com:6380' }).summary.tls, true);
  assert.equal(dbConfig({ FALKOR_URL: 'rediss://u:p@h.example.com:6380' }).summary.tls, true);
  const plain = dbConfig({ FALKOR_URL: 'falkor://h.example.com:6380' }); assert.equal(plain.summary.tls, false); assert.equal(plain.warnings.length, 1);
});
test('remote host without TLS produces a warning; bad input is rejected', () => {
  assert.equal(dbConfig({ FALKOR_HOST: 'db.example.com' }).warnings.length, 1);
  assert.throws(() => dbConfig({ FALKOR_URL: 'http://x' }), /must start with/);
  assert.throws(() => dbConfig({ FALKOR_URL: 'not a url' }), /valid URL/);
  assert.throws(() => dbConfig({ FALKOR_PORT: 'abc' }), /port/);
});
test('graph name is validated', () => {
  assert.equal(graphName({}), 'devgraph-premium'); assert.equal(graphName({ FALKOR_GRAPH: 'my_graph-1' }), 'my_graph-1');
  assert.throws(() => graphName({ FALKOR_GRAPH: 'a b; MATCH' }), /FALKOR_GRAPH/);
});
test('errors never leak the password or URL credentials', () => {
  const env = { FALKOR_PASSWORD: 'sup3r-secret', FALKOR_URL: 'falkors://user:urlsecret@h:1' };
  const m = safeError(new Error('connect failed to falkors://user:urlsecret@h:1 with sup3r-secret'), env);
  assert.ok(!m.includes('sup3r-secret') && !m.includes('urlsecret'), m);
});
test('graphs of the original project are protected', () => {
  for (const g of ['devgraph', 'devgraph-test']) assert.throws(() => graphName({ FALKOR_GRAPH: g }), /protected/);
  assert.equal(graphName({ FALKOR_GRAPH: 'devgraph_test_ab12' }), 'devgraph_test_ab12');
});
