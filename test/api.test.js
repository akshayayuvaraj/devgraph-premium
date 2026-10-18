// API guard tests that need no database: CSRF, authentication, validation order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import app from '../src/server.js';
import { PUBLIC_DIR } from '../src/server.js';

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let srv;
let base;

before(() => new Promise((resolve) => {
  srv = app.listen(0, () => {
    base = 'http://localhost:' + srv.address().port;
    resolve();
  });
}));

after(async () => {
  if (srv) {
    await new Promise((resolve) => srv.close(resolve));
  }
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

const H = {
  'content-type': 'application/json',
  'x-requested-with': 'devgraph'
};

test('mutating request without CSRF header is rejected', async () => {
  const r = await fetch(base + '/api/agent/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });

  assert.equal(r.status, 403);
});

for (const [method, endpoint] of [
  ['GET', '/api/overview'],
  ['GET', '/api/incidents'],
  ['POST', '/api/incidents'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/memories'],
  ['POST', '/api/agent/query']
]) {
  test(
    'unauthenticated ' + method + ' ' + endpoint + ' -> 401',
    async () => {
      const r = await fetch(base + endpoint, {
        method,
        headers: H,
        body: method === 'POST' ? '{}' : undefined
      });

      assert.equal(r.status, 401);
    }
  );
}

test('static UI is served with security headers', async () => {
  const r = await fetch(base + '/');

  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('content-security-policy'));
});

const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);

test('public directory is a valid absolute filesystem path containing index.html', () => {
  assert.ok(path.isAbsolute(PUBLIC_DIR), PUBLIC_DIR);
  assert.ok(existsSync(path.join(PUBLIC_ROOT, 'index.html')));
});

test('GET / serves the landing page and /app.html serves the application', async () => {
  for (const [endpoint, marker] of [
    ['/', 'DevGraph AI: traceable'],
    ['/index.html', 'DevGraph AI: traceable'],
    ['/app.html', 'id="app"']
  ]) {
    const r = await fetch(base + endpoint);
    assert.equal(r.status, 200, endpoint);

    const html = await r.text();
    assert.ok(
      html.includes(marker),
      endpoint + ' missing ' + marker
    );
  }
});

test('brand SVGs exist, are well-formed XML and are served', async () => {
  for (const filename of [
    'icon.svg',
    'favicon.svg',
    'logo-horizontal.svg',
    'logo-horizontal-dark.svg',
    'logo-horizontal-light.svg'
  ]) {
    const svgPath = path.join(PUBLIC_ROOT, 'brand', filename);
    const content = readFileSync(svgPath, 'utf8');

    assert.match(
      content,
      /^(?:<!--[\s\S]*?-->\s*)?<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
      filename
    );
    assert.ok(content.trim().endsWith('</svg>'), filename);

    const r = await fetch(base + '/brand/' + filename);
    assert.equal(r.status, 200, filename);
    assert.match(r.headers.get('content-type') || '', /svg/);
  }
});

test('every local href/src in the pages resolves to a real file (no broken links)', () => {
  for (const page of ['index.html', 'app.html']) {
    const html = readFileSync(path.join(PUBLIC_ROOT, page), 'utf8');

    for (const match of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
      const urlPath = match[1];
      const relativePath = urlPath === '/'
        ? 'index.html'
        : urlPath.slice(1);

      assert.ok(
        existsSync(path.join(PUBLIC_ROOT, relativePath)),
        page + ' links to missing ' + urlPath
      );
    }
  }
});

test('demo seed refuses any graph except devgraph-premium (and never contacts the database)', () => {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));

  for (const [graph, expectedError] of [
    ['devgraph', /protected/],
    ['devgraph-test', /protected/],
    ['devgraph_test_x', /Refusing to run on graph.*Expected "devgraph-premium"/],
    ['production', /Refusing to run on graph.*Expected "devgraph-premium"/]
  ]) {
    const result = spawnSync(
      process.execPath,
      ['src/seed-demo.js'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          FALKOR_GRAPH: graph,
          FALKOR_PORT: '6399'
        },
        encoding: 'utf8',
        timeout: 15000
      }
    );

    assert.equal(result.status, 1, graph);
    assert.match(result.stderr, expectedError, graph);
    assert.ok(
      !/ECONNREFUSED/.test(result.stderr),
      'must refuse before connecting'
    );
  }
});