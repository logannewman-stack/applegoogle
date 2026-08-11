import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/api/app.js';

let app;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'northstar-test-'));
  app = await createApp({ dataDir, anonDailyLimit: 6, freeDailyLimit: 5 });

  app.index.addDocument({
    url: 'https://brew.example.org/guides/pour-over',
    title: 'Pour-Over Coffee: A Complete Guide',
    description: 'How to brew pour-over coffee at home.',
    text: 'Grind medium fine, bloom for thirty seconds, pour in slow spirals.',
    links: [],
    fetchedAt: new Date().toISOString(),
  });
  app.index.addDocument({
    url: 'https://code.example.net/js/closures',
    title: 'JavaScript Closures',
    description: 'Functions that remember their scope.',
    text: 'A closure keeps a live reference to variables from where it was created.',
    links: [],
    fetchedAt: new Date().toISOString(),
  });
  app.index.computeAuthority();

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path, headers = {}) => fetch(base + path, { headers });
const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('GET / serves the monochrome Northstar page with the story', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Northstar'));
  assert.ok(html.includes('No ads. No sponsored results.'));
  assert.ok(html.includes('NOBODY CAN BUY THE SKY'), 'the tagline beat ships');
  assert.ok(html.includes('Skip the story'), 'the story is skippable');
  assert.ok(html.includes('Start searching truly'), 'the finale CTA ships');
});

test('search finds seeded documents and explains why', async () => {
  const res = await get('/v1/search?q=pour+over+coffee');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.total >= 1);
  const top = body.results[0];
  assert.equal(top.url, 'https://brew.example.org/guides/pour-over');
  assert.ok(top.snippet.length > 0);
  assert.equal(body.plan, 'anonymous');

  // The receipt: every result explains itself.
  assert.ok(top.why, 'results carry a why object');
  assert.equal(top.why.matched.of, 3);
  assert.equal(top.why.matched.missing.length, 0);
  assert.ok(top.why.matched.inTitle.length >= 1, 'title hits are called out');
  assert.match(top.why.summary, /matches all 3/i);
  assert.match(top.why.summary, /title/i);
  assert.ok(top.why.factors.textRelevance > 0);
  assert.ok(top.why.factors.linkAuthority >= 1);
});

test('anonymous search sets a session cookie and records history', async () => {
  const res = await get('/v1/search?q=closures');
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('ns_session='), 'session cookie minted');
  const cookie = setCookie.split(';')[0];

  const hist = await get('/v1/history', { cookie });
  const histBody = await hist.json();
  assert.ok(histBody.history.some((h) => h.query === 'closures'), 'search was recorded');

  const del = await fetch(`${base}/v1/history?query=closures`, { method: 'DELETE', headers: { cookie } });
  assert.equal((await del.json()).removed, 1);

  const after = await get('/v1/history', { cookie });
  assert.ok(!(await after.json()).history.some((h) => h.query === 'closures'), 'entry deleted');
});

test('search without a query is a 400', async () => {
  const res = await get('/v1/search');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'missing_query');
});

test('creating an account rotates the session and migrates anonymous history', async () => {
  const s = await get('/v1/search?q=sourdough');
  const oldCookie = s.headers.get('set-cookie').split(';')[0];

  const created = await post('/v1/account', { email: 'migrate@example.com' }, { cookie: oldCookie });
  assert.equal(created.status, 201);
  const newCookie = created.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, oldCookie, 'session id rotates at the privilege boundary');

  const oldSess = await get('/v1/session', { cookie: oldCookie });
  assert.equal((await oldSess.json()).signedIn, false, 'the pre-signin session id is dead');

  const hist = await get('/v1/history', { cookie: newCookie });
  assert.ok(
    (await hist.json()).history.some((h) => h.query === 'sourdough'),
    'anonymous history followed the user into the account',
  );
});

test('signing in with an API key binds this browser to the account', async () => {
  const created = await post('/v1/account', { email: 'signin@example.com' });
  const { apiKey } = await created.json();

  const res = await post('/v1/session/signin', { apiKey });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const sess = await get('/v1/session', { cookie });
  const body = await sess.json();
  assert.equal(body.signedIn, true);
  assert.equal(body.account.email, 'signin@example.com');

  const bad = await post('/v1/session/signin', { apiKey: 'ns_not_a_real_key' });
  assert.equal(bad.status, 401);
});

test('cross-site requests cannot spend a session or plant history', async () => {
  const created = await post('/v1/account', { email: 'csrf@example.com' });
  const cookie = created.headers.get('set-cookie').split(';')[0];

  const res = await get('/v1/search?q=planted+embarrassing+query', { cookie, 'sec-fetch-site': 'cross-site' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).plan, 'anonymous', 'the cookie session is ignored cross-site');

  const hist = await get('/v1/history', { cookie });
  assert.ok(
    !(await hist.json()).history.some((h) => h.query.includes('planted')),
    'cross-site searches never touch history',
  );
});

test('anonymous searches hit the daily limit, then 402 with an upgrade path', async () => {
  // Earlier tests spent part of the anonymous allowance; searching until
  // refusal keeps this test independent of exact ordering.
  let res;
  for (let i = 0; i <= 8; i++) {
    res = await get('/v1/search?q=closures');
    if (res.status === 402) break;
    assert.equal(res.status, 200);
  }
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error.code, 'subscription_required');
  assert.ok(body.error.upgrade.subscribe.includes('/v1/subscribe'));
});

test('account lifecycle: create, authenticate, subscribe, cancel', async () => {
  const created = await post('/v1/account', { email: 'logan@example.com' });
  assert.equal(created.status, 201);
  const { apiKey, account } = await created.json();
  assert.ok(apiKey.startsWith('ns_'));
  assert.equal(account.plan, 'free');

  const auth = { authorization: `Bearer ${apiKey}` };

  const me = await get('/v1/account', auth);
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.account.email, 'logan@example.com');
  assert.equal(meBody.usageToday.limit, 5);

  // Keyed search works even though the anonymous IP limit is exhausted.
  const search = await get('/v1/search?q=closures', auth);
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.equal(searchBody.plan, 'free');

  const sub = await post('/v1/subscribe', { plan: 'monthly' }, auth);
  assert.equal(sub.status, 200);
  const subBody = await sub.json();
  assert.equal(subBody.subscription.status, 'active');

  const afterSub = await get('/v1/account', auth);
  assert.equal((await afterSub.json()).account.plan, 'subscriber');

  const cancel = await post('/v1/subscribe/cancel', {}, auth);
  assert.equal(cancel.status, 200);
  const cancelBody = await cancel.json();
  assert.equal(cancelBody.subscription.status, 'canceled');
});

test('query cache serves repeats; private searches stay out of history', async () => {
  const created = await post('/v1/account', { email: 'cache@example.com' });
  const { apiKey } = await created.json();
  const auth = { authorization: `Bearer ${apiKey}` };

  const first = await get('/v1/search?q=sourdough+or+espresso', auth);
  assert.equal(first.headers.get('x-cache'), 'miss');
  const second = await get('/v1/search?q=sourdough+or+espresso', auth);
  assert.equal(second.headers.get('x-cache'), 'hit');
  const secondBody = await second.json();
  assert.equal(secondBody.cached, true);

  const priv = await get('/v1/search?q=do+not+remember+this&private=1', auth);
  assert.equal((await priv.json()).private, true);

  const hist = await get('/v1/history', auth);
  const { history } = await hist.json();
  const entry = history.find((h) => h.query === 'sourdough or espresso');
  assert.ok(entry, 'keyed searches recorded under the account');
  assert.equal(entry.times, 2, 'repeat searches collapse into one entry');
  assert.ok(!history.some((h) => h.query === 'do not remember this'), 'private search never recorded');
});

test('accounts bind to the browser session: cookie sign-in, name, logout', async () => {
  const created = await post('/v1/account', { email: 'story@example.com', name: '  Nova   Vega  ' });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.account.name, 'Nova Vega', 'name is cleaned and stored');
  assert.equal(createdBody.signedIn, true);
  const cookie = created.headers.get('set-cookie').split(';')[0];

  // Cookie alone authenticates — no bearer key in the browser.
  const me = await get('/v1/account', { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.name, 'Nova Vega');

  const search = await get('/v1/search?q=coffee', { cookie });
  assert.equal((await search.json()).plan, 'free', 'session-bound searches use account limits');

  await fetch(`${base}/v1/account/logout`, { method: 'POST', headers: { cookie } });
  const after = await get('/v1/account', { cookie });
  assert.equal(after.status, 401, 'logout unbinds the session');
});

test('session endpoint reports sign-in state without 401s', async () => {
  const anon = await get('/v1/session');
  assert.equal(anon.status, 200);
  assert.equal((await anon.json()).signedIn, false);

  const created = await post('/v1/account', { email: 'session@example.com', name: 'Sess' });
  const cookie = created.headers.get('set-cookie').split(';')[0];
  const signed = await get('/v1/session', { cookie });
  assert.equal(signed.status, 200);
  const body = await signed.json();
  assert.equal(body.signedIn, true);
  assert.equal(body.account.name, 'Sess');
});

test('duplicate accounts are rejected', async () => {
  await post('/v1/account', { email: 'dup@example.com' });
  const second = await post('/v1/account', { email: 'dup@example.com' });
  assert.equal(second.status, 409);
});

test('bad API keys are rejected', async () => {
  const res = await get('/v1/search?q=coffee', { authorization: 'Bearer key_not_real' });
  assert.equal(res.status, 401);
});

test('ranking transparency endpoint publishes the signals and the exclusions', async () => {
  const res = await get('/v1/ranking');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.signals.length, 4);
  assert.ok(body.neverConsidered.length >= 3);
  assert.match(body.promise, /cannot be bought/i);
});

test('plans endpoint states the no-ads principle', async () => {
  const res = await get('/v1/plans');
  const body = await res.json();
  assert.equal(body.plans.length, 2);
  assert.ok(body.principles.some((p) => /No advertising/i.test(p)));
});

test('suggest completes prefixes from the index', async () => {
  const res = await get('/v1/suggest?q=clo');
  const body = await res.json();
  assert.ok(body.suggestions.some((s) => s.startsWith('clo')));
});

test('stats endpoint reports index size', async () => {
  const res = await get('/v1/stats');
  const body = await res.json();
  assert.equal(body.documents, 2);
  assert.ok(body.terms > 0);
});
