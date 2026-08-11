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
