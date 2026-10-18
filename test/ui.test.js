// Drives the real index.html (jsdom) against the real server + an isolated throwaway graph. Skipped when FalkorDB is unreachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TEST_GRAPH, probe, loadFixtures, cleanup } from './helpers.js';
const db = await probe();
const opts = { skip: db.skip };
if (db.up) await loadFixtures();
const { default: app } = await import('../src/server.js');
let srv, base, win, doc; const errors = [];
const wait = async (fn, what, ms = 4000) => { const t = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout waiting for: ' + what + (errors.length ? ' | page errors: ' + errors.join('; ') : '')); await new Promise(r => setTimeout(r, 25)); } };
before(async () => { if (!db.up) return;
  await new Promise(r => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; r(); }); });
  let cookie = ''; const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8').replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.confirm = () => true; w.alert = (m) => errors.push('alert: ' + m); w.prompt = () => null;
    w.vis = { DataSet: class { constructor(a) { this.a = a; } get() { return this.a; } update() {} }, Network: class { on() {} fit() {} focus() {} selectNodes() {} } };
    w.fetch = async (u, o = {}) => { const r = await fetch(new URL(u, base), { ...o, headers: { ...(o.headers || {}), cookie } }); const sc = r.headers.getSetCookie?.() || []; for (const c of sc) cookie = c.startsWith('devgraph_sid=;') || /Max-Age=0/.test(c) ? '' : c.split(';')[0]; return r; };
    w.addEventListener('error', e => errors.push(e.message)); } });
  win = dom.window; doc = win.document; });
after(async () => { srv?.close(); win?.close(); await cleanup(); });
const $ = (id) => doc.getElementById(id), nav = (p) => doc.querySelector(`nav [data-go="${p}"]`).click();
const submit = (id) => $(id).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

test('first visit shows admin setup, then the dashboard with live data', opts, async () => {
  await wait(() => !$('auth').hidden, 'auth card'); assert.match($('atitle').textContent, /first account/i);
  $('em').value = 'ui-admin@example.com'; $('pw').value = 'ui-admin-password'; submit('af');
  await wait(() => !$('app').hidden, 'app visible'); assert.equal($('role').textContent, 'admin');
  await wait(() => $('stats').textContent.includes('Relationships'), 'overview stats');
  assert.match($('top').textContent, /auth-service/); assert.match($('chains').textContent, /→/); assert.match($('unres').textContent, /INC-140/); assert.ok($('demo').hidden, 'no demo banner on a graph without demo records');
});
test('investigate: answer cites evidence; decision trace, evidence, memory and uncertainty panels render', opts, async () => {
  nav('investigate'); await wait(() => $('chips').textContent.includes('What breaks if'), 'chips from live services');
  $('q').value = 'What should we investigate first for api-gateway?'; submit('f');
  await wait(() => $('ans').textContent.includes('Recommended next action'), 'answer'); assert.match($('ans').textContent, /evidence-only/); assert.match($('ans').textContent, /No model was used/);
  assert.ok($('ans').querySelector('[data-ev]'), 'citations are clickable chips'); assert.ok(!$('dec').hidden);
  assert.match(doc.querySelector('[data-tp="evidence"]').textContent, /direct|inferred/); assert.match(doc.querySelector('[data-tp="trace"]').textContent, /find_related_incidents/);
  assert.match(doc.querySelector('[data-tp="memory"]').textContent, /Saved as investigation/);
  $('ans').querySelector('[data-ev]').click(); assert.ok(doc.querySelector('.ev.hl'), 'clicking a citation highlights its evidence');
});
test('action: proposal needs confirmation, success is read back from the graph, failure is reported truthfully', opts, async () => {
  doc.querySelector('[data-tab="action"]').click(); await wait(() => $('actgo'), 'action button'); assert.equal($('actgo').disabled, false);
  assert.match(doc.querySelector('[data-tp="action"]').textContent, /INC-140/); await wait(() => /No task has been created/.test($('outcome').textContent), 'outcome read back before acting');
  $('actgo').click(); assert.ok(!$('modal').hidden); assert.match($('mb').textContent, /Nothing has been written yet/);
  submit('mform'); await wait(() => /Lena Ortiz/.test($('outcome').textContent), 'recorded outcome'); assert.ok($('modal').hidden); assert.match($('actout').textContent, /created/);
});
test('graph page: legend, search, filter, fit and reset work with real nodes', opts, async () => {
  nav('graph'); await wait(() => $('net2').innerHTML === '' || !$('net2').querySelector('.skel'), 'graph loaded'); assert.match($('legend').textContent, /Service/);
  $('gs').value = 'auth'; $('gs').dispatchEvent(new win.Event('input')); $('gt').value = 'Incident'; $('gt').dispatchEvent(new win.Event('change')); $('gfit').click(); $('grst').click(); assert.equal($('gt').value, '');
});
test('incidents: list with owners, filter, edit via modal, create via modal', opts, async () => {
  nav('incidents'); await wait(() => $('ilist').textContent.includes('INC-101'), 'incident list'); assert.match($('ilist').textContent, /owners Priya Nair/);
  $('ist').value = 'open'; $('ist').dispatchEvent(new win.Event('input')); await wait(() => !$('ilist').textContent.includes('INC-101') && $('ilist').textContent.includes('INC-140'), 'status filter');
  doc.querySelector('[data-act="edit"]').click(); assert.ok(!$('modal').hidden); doc.querySelector('[name="status"]').value = 'investigating'; submit('mform');
  $('ist').value = ''; $('ist').dispatchEvent(new win.Event('input')); await wait(() => /investigating/.test($('ilist').textContent), 'edit applied'); assert.ok(!$('newinc').hidden); $('newinc').click(); doc.querySelector('[name="title"]').value = 'UI incident'; doc.querySelector('[name="severity"]').value = 'critical'; submit('mform');
  await wait(() => $('ilist').textContent.includes('UI incident'), 'new incident listed');
  doc.querySelector('[data-act="tasks"]').click();
});
test('memory page lists, reopens the stored decision trace, and deletes', opts, async () => {
  nav('memory'); await wait(() => $('mem').textContent.includes('api-gateway'), 'memory item'); assert.match($('mem').textContent, /outcome: task created/);
  doc.querySelector('[data-open]').click(); await wait(() => /stored investigation/.test($('ans').textContent), 'stored trace reopened'); assert.match(doc.querySelector('[data-tp="trace"]').textContent, /find_related_incidents/);
  nav('memory'); await wait(() => doc.querySelector('[data-del]'), 'list'); doc.querySelector('[data-del]').click(); submit('mform'); await wait(() => /No saved investigations/.test($('mem').textContent), 'memory deleted');
});
test('settings: honest status, LLM test, users and audit log', opts, async () => {
  nav('settings'); await wait(() => $('st').textContent.includes('database'), 'status'); assert.match($('st').textContent, /not configured \(evidence-only mode\)/); assert.ok(!$('llmtest').hidden);
  $('llmtest').click(); await wait(() => /not configured/.test($('llmout').textContent), 'llm test result');
  await wait(() => $('ul').textContent.includes('ui-admin@example.com') && $('al').textContent.includes('task:create') && $('al').textContent.includes('incident:update'), 'users + audit');
  $('theme').click(); assert.equal(doc.documentElement.dataset.theme, 'light');
});
test('sign out leaves no page errors', opts, async () => { $('out').click(); await new Promise(r => setTimeout(r, 200)); assert.deepEqual(errors, []); });
