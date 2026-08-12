// Discovery, proven end to end against a real local web server.
// A stub provider stands in for Wikipedia/Brave/etc — the point is that
// Northstar does the fetching, indexing and ranking itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { makeConfig } from '../src/config.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Discovery } from '../src/websearch/discovery.js';
import { PROVIDERS, getProvider, wikipedia } from '../src/websearch/providers.js';
import { search } from '../src/core/ranker.js';

const PAGES = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/' },
  '/tides': {
    type: 'text/html',
    body: `<html lang="en"><head><title>How Tides Work</title>
      <meta name="description" content="The moon, the sun, and the bulge of water that follows them."></head>
      <body><p>Tides are the ocean's response to the gravity of the moon and, to a lesser degree, the sun.
      A bulge of water follows the moon around the Earth while a second bulge forms on the opposite side.</p></body></html>`,
  },
  '/moon': {
    type: 'text/html',
    body: `<html lang="en"><head><title>The Moon's Orbit</title></head>
      <body><p>The moon orbits the Earth roughly every twenty-seven days, and its gravity raises the tides.</p>
      <a href="/tides">Tides</a></body></html>`,
  },
  '/private/secret': {
    type: 'text/html',
    body: '<html><head><title>Secret</title></head><body><p>Tides and moons, but disallowed.</p></body></html>',
  },
};

let server, origin;
const requested = [];

before(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url);
    const page = PAGES[req.url];
    if (!page) return res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': page.type });
    res.end(page.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); server.closeAllConnections?.(); });

const makeIndex = () => new SearchIndex({ data: emptyIndexData(), save: async () => {} });

function stubProvider(urls) {
  PROVIDERS.stub = {
    id: 'stub', needsKey: false, label: 'Stub',
    async discover() { return urls; },
  };
  return makeConfig({
    webDiscovery: true, searchProvider: 'stub',
    crawlDelayMs: 5, crawlTimeoutMs: 4000, discoveryCooldownMs: 60000,
  });
}

test('discovery fetches, indexes and ranks the pages a provider names', async () => {
  const index = makeIndex();
  const config = stubProvider([`${origin}/tides`, `${origin}/moon`]);
  const d = new Discovery(index, config);

  assert.equal(index.docCount, 0);
  const result = await d.expand('how tides work');
  assert.equal(result.added, 2);
  assert.equal(result.provider, 'stub');
  assert.equal(index.docCount, 2, 'the pages are now genuinely in our index');

  // And they rank by Northstar's own signals, with reasoning attached.
  const { results } = search(index, 'tides moon');
  assert.ok(results.length >= 1);
  assert.ok(results[0].why.reasons.length > 0, 'discovered pages explain themselves like any other');
  assert.ok(results.some((r) => /tides/i.test(r.title)));
});

test('discovery obeys robots.txt exactly like an ordinary crawl', async () => {
  const index = makeIndex();
  const config = stubProvider([`${origin}/private/secret`, `${origin}/tides`]);
  const d = new Discovery(index, config);
  requested.length = 0;

  const result = await d.expand('secret tides');
  assert.equal(result.added, 1, 'only the allowed page is indexed');
  assert.ok(!requested.includes('/private/secret'), 'the disallowed URL is never even requested');
  assert.ok(requested.includes('/robots.txt'));
});

test('a provider ordering never becomes a ranking', async () => {
  const index = makeIndex();
  // The provider lists /moon first; relevance should still decide.
  const config = stubProvider([`${origin}/moon`, `${origin}/tides`]);
  await new Discovery(index, config).expand('tides');

  const { results } = search(index, 'bulge of water following the moon');
  assert.equal(results[0].url, `${origin}/tides`,
    'the page that actually matches wins, not the one listed first');
});

test('already-indexed pages are not refetched', async () => {
  const index = makeIndex();
  const config = stubProvider([`${origin}/tides`]);
  const d = new Discovery(index, config);

  await d.expand('tides');
  requested.length = 0;
  const second = await d.expand('tides again');
  assert.equal(second.added, 0);
  assert.ok(!requested.includes('/tides'), 'nothing is fetched twice');
});

test('identical concurrent expansions share one run', async () => {
  const index = makeIndex();
  const config = stubProvider([`${origin}/tides`, `${origin}/moon`]);
  const d = new Discovery(index, config);
  const [a, b] = await Promise.all([d.expand('tides'), d.expand('tides')]);
  assert.equal(a, b, 'the same promise is handed to both callers');
  assert.equal(index.docCount, 2, 'pages are indexed once, not twice');
});

test('a repeated query cools down instead of hammering the provider', async () => {
  const index = makeIndex();
  const config = stubProvider([`${origin}/tides`]);
  const d = new Discovery(index, config);
  await d.expand('tides');
  assert.equal(d.isCoolingDown('tides'), true);
  const again = await d.expand('tides');
  assert.equal(again.skipped, 'cooling_down');
  // …unless explicitly forced.
  const forced = await d.expand('tides', { force: true });
  assert.notEqual(forced.skipped, 'cooling_down');
});

// A page server that takes `delay` ms to answer anything but robots.txt.
async function slowSite(delay, host = '127.0.0.1') {
  const s = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /');
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' })
        .end('<html><head><title>Tides here</title></head><body><p>A page about tides and the moon, with plenty of words to index properly.</p></body></html>');
    }, delay);
  });
  await new Promise((r) => s.listen(0, host, r));
  return { server: s, url: `http://${host}:${s.address().port}/page` };
}

test('different hosts are fetched concurrently, not one after another', async () => {
  // Politeness is per-host, so two different hosts must not queue behind
  // each other. 127.0.0.1 and localhost are distinct hostnames.
  const a = await slowSite(200, '127.0.0.1');
  const b = await slowSite(200, 'localhost');
  const index = makeIndex();
  const { Crawler } = await import('../src/crawler/crawler.js');
  const crawler = new Crawler(index, makeConfig({ crawlDelayMs: 800, crawlTimeoutMs: 5000 }));

  try {
    const t0 = Date.now();
    const stats = await crawler.fetchAll([a.url, b.url]);
    const elapsed = Date.now() - t0;
    assert.equal(stats.indexed, 2);
    // Same-host would have cost ≥ 800ms of politeness delay on top.
    assert.ok(elapsed < 800, `ran in parallel (${elapsed}ms)`);
  } finally {
    for (const s of [a.server, b.server]) { s.close(); s.closeAllConnections?.(); }
  }
});

test('one slow host cannot hang a search — the rest finishes in the background', async () => {
  const slow = await slowSite(3000, 'localhost'); // a different host to `origin`
  const index = makeIndex();
  const config = stubProvider([slow.url, `${origin}/tides`]);
  config.discoveryBudgetMs = 500;
  const d = new Discovery(index, config);

  try {
    const t0 = Date.now();
    const result = await d.expand('tides');
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 2000, `answered in ${elapsed}ms instead of waiting 3s`);
    assert.ok(result.added >= 1, 'the fast page made this response');
    assert.equal(result.deferred, 1, 'the slow page is deferred, not dropped or failed');
    assert.equal(result.errors, 0, 'a budget cut is not an error');
  } finally {
    await d.pending?.catch(() => {});
    slow.server.close();
    slow.server.closeAllConnections?.();
  }
});

test('discovery is off unless asked for', async () => {
  const index = makeIndex();
  const d = new Discovery(index, makeConfig({ webDiscovery: false }));
  assert.equal(d.enabled, false);
  await assert.rejects(() => d.expand('anything'), (err) => err.code === 'discovery_disabled');
});

test('providers needing a key say so plainly', () => {
  assert.throws(
    () => getProvider(makeConfig({ searchProvider: 'brave', searchApiKey: null })),
    (err) => err.code === 'missing_provider_key' && /BRAVE_API_KEY/.test(err.message),
  );
  assert.throws(
    () => getProvider(makeConfig({ searchProvider: 'nope' })),
    (err) => err.code === 'unknown_provider',
  );
  // Wikipedia is the keyless default.
  assert.equal(getProvider(makeConfig({ searchProvider: 'wikipedia' })).id, 'wikipedia');
  assert.equal(wikipedia.needsKey, false);
});

test('the Wikipedia provider asks for URLs and returns only URLs', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        query: { pages: {
          '2': { index: 2, fullurl: 'https://en.wikipedia.org/wiki/Second' },
          '1': { index: 1, fullurl: 'https://en.wikipedia.org/wiki/First' },
        } },
      }),
    };
  };
  const urls = await wikipedia.discover('polaris', { limit: 5, config: makeConfig(), fetchImpl: fakeFetch });
  assert.deepEqual(urls, [
    'https://en.wikipedia.org/wiki/First',
    'https://en.wikipedia.org/wiki/Second',
  ]);
  assert.match(calls[0], /generator=search/);
  assert.match(calls[0], /polaris/);
});
