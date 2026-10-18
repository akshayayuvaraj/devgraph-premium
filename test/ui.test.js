
 // Drives the real app.html through jsdom against the real server
 // and an isolated test graph. Live UI tests are skipped if FalkorDB is unavailable.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TEST_GRAPH, probe, loadFixtures, cleanup } from './helpers.js';

const db = await probe();
const opts = { skip: db.skip };

if (db.up) {
  await loadFixtures();
}

const { default: app } = await import('../src/server.js');

let srv;
let base;
let win;
let doc;

const errors = [];
const TEST_EMAIL = 'ui-admin@example.com';
const TEST_PASSWORD = 'ui-admin-password';

const wait = async (fn, what, ms = 6000) => {
  const started = Date.now();

  while (Date.now() - started <= ms) {
    try {
      const value = fn();
      if (value) return value;
    } catch {
      // The UI may not have rendered the requested element yet.
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(
    `timeout waiting for: ${what}` +
    (errors.length ? ` | page errors: ${errors.join('; ')}` : '')
  );
};

const $ = id => doc.getElementById(id);

const nav = page => {
  const button = doc.querySelector(`nav [data-go="${page}"]`);
  assert.ok(button, `Navigation button not found: ${page}`);
  button.click();
};

const submit = id => {
  const form = $(id);
  assert.ok(form, `Form not found: ${id}`);

  form.dispatchEvent(
    new win.Event('submit', {
      bubbles: true,
      cancelable: true
    })
  );
};

const signInOrCreateFirstAccount = async () => {
  await wait(() => $('auth') && !$('auth').hidden, 'authentication card');

  const title = $('atitle')?.textContent ?? '';
  const isFirstAccount = /first account/i.test(title);

  $('em').value = TEST_EMAIL;
  $('pw').value = TEST_PASSWORD;

  // The app uses the same authentication form for initial setup and sign-in.
  submit('af');

  await wait(() => $('app') && !$('app').hidden, 'app visible');

  assert.equal($('role')?.textContent, 'admin');

  return { isFirstAccount };
};

before(async () => {
  if (!db.up) return;

  await new Promise(resolve => {
    srv = app.listen(0, () => {
      base = `http://127.0.0.1:${srv.address().port}`;
      resolve();
    });
  });

  let cookie = '';

  const html = readFileSync(
    new URL('../public/app.html', import.meta.url),
    'utf8'
  ).replace(
    /<script\b[^>]*src=["'][^"']*cdnjs[^"']*["'][^>]*>\s*<\/script>/gi,
    ''
  );

  const dom = new JSDOM(html, {
    url: `${base}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,

    beforeParse(w) {
      w.confirm = () => true;
      w.alert = message => errors.push(`alert: ${message}`);
      w.prompt = () => null;

      // Avoid loading the external graph visualization library in jsdom.
      w.vis = {
        DataSet: class {
          constructor(items = []) {
            this.items = items;
          }

          get() {
            return this.items;
          }

          update() {}
        },

        Network: class {
          on() {}
          fit() {}
          focus() {}
          selectNodes() {}
          destroy() {}
        }
      };

      // Forward requests to the real server and preserve its session cookie.
      w.fetch = async (input, options = {}) => {
        const headers = new Headers(options.headers || {});

        if (cookie) {
          headers.set('cookie', cookie);
        }

        const response = await fetch(new URL(input, base), {
          ...options,
          headers
        });

        for (const setCookie of response.headers.getSetCookie?.() ?? []) {
          const pair = setCookie.split(';')[0];

          if (
            setCookie.startsWith('devgraph_sid=;') ||
            /Max-Age=0/i.test(setCookie)
          ) {
            cookie = '';
          } else if (pair.startsWith('devgraph_sid=')) {
            cookie = pair;
          }
        }

        return response;
      };

      w.addEventListener('error', event => {
        errors.push(event.message);
      });
    }
  });

  win = dom.window;
  doc = win.document;
});

after(async () => {
  if (srv) {
    await new Promise(resolve => srv.close(resolve));
  }

  win?.close();
  await cleanup();
});

test('first visit shows admin setup, then the dashboard with live data', opts, async () => {
  const { isFirstAccount } = await signInOrCreateFirstAccount();

  // A reused test graph can already have an admin account.
  // In that case, sign-in is valid; first-account setup is not expected.
  if (isFirstAccount) {
    assert.match($('atitle').textContent, /first account/i);
  }

  await wait(
    () => $('stats')?.textContent.includes('Relationships'),
    'overview stats'
  );

  assert.match($('top').textContent, /auth-service/i);
  assert.match($('chains').textContent, /→/);
  assert.match($('unres').textContent, /INC-140/i);
  assert.ok(
    $('demo').hidden,
    'no demo banner on a graph without demo records'
  );
});

test('investigate: answer cites evidence; trace, evidence, memory and uncertainty panels render', opts, async () => {
  nav('investigate');

  await wait(
    () => $('chips')?.textContent.includes('What breaks if'),
    'chips from live services'
  );

  $('q').value = 'What should we investigate first for api-gateway?';
  submit('f');

  await wait(
    () => $('ans')?.textContent.includes('Recommended next action'),
    'answer'
  );

  assert.match($('ans').textContent, /evidence-only/i);
  assert.match($('ans').textContent, /No model was used/i);
  assert.ok($('ans').querySelector('[data-ev]'), 'citations are clickable');

  assert.ok(!$('dec').hidden);
  assert.match(
    doc.querySelector('[data-tp="evidence"]')?.textContent ?? '',
    /direct|inferred/i
  );
  assert.match(
    doc.querySelector('[data-tp="trace"]')?.textContent ?? '',
    /find_related_incidents/i
  );
  assert.match(
    doc.querySelector('[data-tp="memory"]')?.textContent ?? '',
    /Saved as investigation/i
  );

  $('ans').querySelector('[data-ev]').click();

  assert.ok(
    doc.querySelector('.ev.hl'),
    'clicking a citation highlights its evidence'
  );
});

test('action: proposal needs confirmation and records the outcome', opts, async () => {
  doc.querySelector('[data-tab="action"]')?.click();

  await wait(() => $('actgo'), 'action button');
  assert.equal($('actgo').disabled, false);

  assert.match(
    doc.querySelector('[data-tp="action"]')?.textContent ?? '',
    /INC-140/i
  );

  await wait(
    () => /No task has been created/i.test($('outcome')?.textContent ?? ''),
    'outcome before acting'
  );

  $('actgo').click();

  assert.ok(!$('modal').hidden);
  assert.match($('mb').textContent, /Nothing has been written yet/i);

  submit('mform');

  await wait(
    () => /Lena Ortiz/i.test($('outcome')?.textContent ?? ''),
    'recorded outcome'
  );

  assert.ok($('modal').hidden);
  assert.match($('actout').textContent, /created/i);
});

test('graph page: legend, search, filter, fit and reset work', opts, async () => {
  nav('graph');

  await wait(
    () => $('net2') && (
      $('net2').innerHTML === '' ||
      !$('net2').querySelector('.skel')
    ),
    'graph loaded'
  );

  assert.match($('legend').textContent, /Service/i);

  $('gs').value = 'auth';
  $('gs').dispatchEvent(new win.Event('input'));

  $('gt').value = 'Incident';
  $('gt').dispatchEvent(new win.Event('change'));

  $('gfit').click();
  $('grst').click();

  assert.equal($('gt').value, '');
});

test('incidents: list, filter, edit and create', opts, async () => {
  nav('incidents');

  await wait(
    () => $('ilist')?.textContent.includes('INC-101'),
    'incident list'
  );

  assert.match($('ilist').textContent, /owners Priya Nair/i);

  $('ist').value = 'open';
  $('ist').dispatchEvent(new win.Event('input'));

  await wait(
    () =>
      !$('ilist').textContent.includes('INC-101') &&
      $('ilist').textContent.includes('INC-140'),
    'status filter'
  );

  doc.querySelector('[data-act="edit"]')?.click();

  assert.ok(!$('modal').hidden);

  doc.querySelector('[name="status"]').value = 'investigating';
  submit('mform');

  $('ist').value = '';
  $('ist').dispatchEvent(new win.Event('input'));

  await wait(
    () => /investigating/i.test($('ilist').textContent),
    'incident edit'
  );

  assert.ok(!$('newinc').hidden);
  $('newinc').click();

  doc.querySelector('[name="title"]').value = 'UI incident';
  doc.querySelector('[name="severity"]').value = 'critical';
  submit('mform');

  await wait(
    () => $('ilist').textContent.includes('UI incident'),
    'new incident listed'
  );

  doc.querySelector('[data-act="tasks"]')?.click();
});

test('memory page lists, reopens and deletes an investigation', opts, async () => {
  nav('memory');

  await wait(
    () => $('mem')?.textContent.includes('api-gateway'),
    'memory item'
  );

  assert.match($('mem').textContent, /outcome: task created/i);

  doc.querySelector('[data-open]')?.click();

  await wait(
    () => /stored investigation/i.test($('ans')?.textContent ?? ''),
    'stored trace reopened'
  );

  assert.match(
    doc.querySelector('[data-tp="trace"]')?.textContent ?? '',
    /find_related_incidents/i
  );

  nav('memory');

  await wait(() => doc.querySelector('[data-del]'), 'memory list');

  doc.querySelector('[data-del]').click();
  submit('mform');

  await wait(
    () => /No saved investigations/i.test($('mem')?.textContent ?? ''),
    'memory deleted'
  );
});

test('settings: status, LLM test, users and audit log', opts, async () => {
  nav('settings');

  await wait(
    () => $('st')?.textContent.includes('database'),
    'status'
  );

  assert.match(
    $('st').textContent,
    /not configured \(evidence-only mode\)/i
  );
  assert.ok(!$('llmtest').hidden);

  $('llmtest').click();

  await wait(
    () => /not configured/i.test($('llmout')?.textContent ?? ''),
    'LLM test result'
  );

  await wait(
    () =>
      $('ul')?.textContent.includes(TEST_EMAIL) &&
      $('al')?.textContent.includes('task:create') &&
      $('al')?.textContent.includes('incident:update'),
    'users and audit log'
  );

  $('theme').click();
  assert.equal(doc.documentElement.dataset.theme, 'light');
});

test('sign out leaves no page errors', opts, async () => {
  $('out')?.click();

  await new Promise(resolve => setTimeout(resolve, 200));

  assert.deepEqual(errors, []);
});
