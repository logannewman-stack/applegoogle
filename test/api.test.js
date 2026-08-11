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
  dataDir = await mkdtemp(join(tmpdir(), 'applegoogle-test-'));
  app = await createApp({ dataDir, anonDailyLimit: 3, freeDailyLimit: 5 });

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

test('GET / serves the monochrome demo page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('No ads. No sponsored results.'));
});

test('search finds seeded documents', async () => {
  const res = await get('/v1/search?q=pour+over+coffee');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.total >= 1);
  assert.equal(body.results[0].url, 'https://brew.example.org/guides/pour-over');
  assert.ok(body.results[0].snippet.length > 0);
  assert.equal(body.plan, 'anonymous');
});

test('search without a query is a 400', async () => {
  const res = await get('/v1/search');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'missing_query');
});

test('anonymous searches hit the daily limit, then 402 with an upgrade path', async () => {
  // anonDailyLimit is 3 and earlier tests spent part of it; searching until
  // refusal keeps this test independent of exact ordering.
  let res;
  for (let i = 0; i <= 4; i++) {
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
  assert.ok(apiKey.startsWith('key_'));
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
