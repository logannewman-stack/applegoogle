// End-to-end crawler test against a local mini-website: three linked pages,
// one of them disallowed by robots.txt, one marked noindex.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { makeConfig } from '../src/config.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Crawler } from '../src/crawler/crawler.js';
import { search } from '../src/core/ranker.js';

const site = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /secret/' },
  '/': {
    type: 'text/html',
    body: `<html lang="en"><head><title>Tiny Site Home</title>
      <meta name="description" content="A tiny site about gardens."></head>
      <body><p>Growing a vegetable garden takes patience and sunlight.</p>
      <a href="/tomatoes">Tomatoes</a> <a href="/secret/plans">Secret</a>
      <a href="/draft">Draft</a></body></html>`,
  },
  '/tomatoes': {
    type: 'text/html',
    body: `<html><head><title>Tomato Growing Guide</title></head>
      <body><p>Tomatoes want deep watering, full sun, and staking. Prune the suckers for larger fruit.</p>
      <a href="/">Home</a></body></html>`,
  },
  '/secret/plans': {
    type: 'text/html',
    body: '<html><head><title>Secret</title></head><body><p>Should never be crawled.</p></body></html>',
  },
  '/draft': {
    type: 'text/html',
    body: `<html><head><title>Draft Post</title><meta name="robots" content="noindex"></head>
      <body><p>Unfinished thoughts about compost, not ready for the index.</p></body></html>`,
  },
};

let server;
let origin;
const hits = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const page = site[req.url];
    if (!page) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': page.type });
    res.end(page.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  server.closeAllConnections?.();
});

test('crawler indexes allowed pages, obeys robots.txt and noindex', async () => {
  const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
  const config = makeConfig({ crawlDelayMs: 10, crawlTimeoutMs: 5000 });
  const crawler = new Crawler(index, config);

  const stats = await crawler.crawl([`${origin}/`], { maxPages: 10, maxDepth: 2 });

  assert.equal(stats.indexed, 2, 'home and tomatoes pages indexed');
  assert.ok(stats.skipped >= 2, 'robots-disallowed and noindex pages skipped');
  assert.ok(!hits.includes('/secret/plans'), 'disallowed URL was never even requested');
  assert.ok(hits.includes('/robots.txt'), 'robots.txt was consulted');

  const urls = Object.values(index.data.docs).map((d) => d.url);
  assert.ok(!urls.some((u) => u.includes('/secret/')));
  assert.ok(!urls.some((u) => u.includes('/draft')));

  const { results } = search(index, 'tomato growing');
  assert.ok(results.length >= 1);
  assert.ok(results[0].url.endsWith('/tomatoes'));
});

// A long article is the kind of source a real question deserves. Throwing the
// whole page away because it ran past a byte ceiling is how "search the web"
// quietly comes back empty.
test('an oversized page is read up to the ceiling, not discarded', async () => {
  const big = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Very Long Article</title></head><body>`
      + `<p>Tidal range is the difference between high and low water.</p>`
      + `<p>${'filler prose about the moon and the sea. '.repeat(40000)}</p></body></html>`);
  });
  await new Promise((resolve) => big.listen(0, '127.0.0.1', resolve));
  const bigOrigin = `http://127.0.0.1:${big.address().port}`;

  try {
    const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
    const config = makeConfig({ crawlMaxBytes: 64 * 1024, crawlDelayMs: 0 });
    const crawler = new Crawler(index, config, { log: () => {} });

    const page = await crawler.fetchPage(`${bigOrigin}/article`);
    assert.equal(page.truncated, true, 'the page was over the ceiling');
    assert.ok(page.html.length <= 64 * 1024, 'and was cut to it');
    assert.match(page.html, /Tidal range is the difference/, 'the opening — the part that answers — survived');

    const stats = await crawler.fetchAll([`${bigOrigin}/article`], { log: () => {} });
    assert.equal(stats.indexed, 1, 'a long page still gets indexed');
    assert.equal(stats.errors, 0);
    assert.equal(search(index, 'tidal range').total, 1, 'and is findable afterwards');
  } finally {
    big.close();
    big.closeAllConnections?.();
  }
});

test('a caller may shrink our courtesy gap but never the one a site asked for', async () => {
  const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });

  // No Crawl-delay in this site's robots.txt, so our own floor is all there is.
  const fast = new Crawler(index, makeConfig({ crawlDelayMs: 5000 }), { log: () => {} });
  const started = Date.now();
  await fast.fetchAll([`${origin}/`, `${origin}/tomatoes`], { delayMs: 0, log: () => {} });
  assert.ok(Date.now() - started < 4000,
    'two pages on one host should not cost a bulk-crawl delay while someone waits');

  // Now a site that does ask for one. The override must not touch it.
  const politeSite = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nCrawl-delay: 1');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Polite</title></head><body><p>Please wait between requests.</p></body></html>');
  });
  await new Promise((resolve) => politeSite.listen(0, '127.0.0.1', resolve));
  const politeOrigin = `http://127.0.0.1:${politeSite.address().port}`;

  try {
    const crawler = new Crawler(index, makeConfig({ crawlDelayMs: 0 }), { log: () => {} });
    const t0 = Date.now();
    await crawler.fetchAll([`${politeOrigin}/a`, `${politeOrigin}/b`], { delayMs: 0, log: () => {} });
    assert.ok(Date.now() - t0 >= 1000,
      "a site's own Crawl-delay is obeyed even when the caller asks for speed");
  } finally {
    politeSite.close();
    politeSite.closeAllConnections?.();
  }
});
