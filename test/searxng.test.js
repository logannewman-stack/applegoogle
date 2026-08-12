// Keyless discovery has to survive the machines it depends on.
//
// Public SearXNG instances are run by volunteers: the JSON API gets switched
// off, the rate limiter trips, a host goes away for a weekend. Any single one
// is a coin flip, so Northstar takes a list and the pool becomes dependable.
// These run against local stand-ins that misbehave in each of those ways.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { makeConfig } from '../src/config.js';
import { searxng, searxngInstances, PROVIDERS } from '../src/websearch/providers.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Discovery } from '../src/websearch/discovery.js';

// A stand-in instance with a chosen failure mode. Returns [origin, close].
async function instance(mode) {
  const server = http.createServer((req, res) => {
    if (mode === 'json_disabled') {
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end('<html><body>Not allowed</body></html>');
    }
    if (mode === 'rate_limited') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ query: 'x', results: [] }));
    }
    if (mode === 'html_only') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>results</body></html>');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      query: 'tidal range',
      results: [
        { url: 'https://example.org/tidal-range', title: 'Tidal range' },
        { url: 'https://example.org/tides', title: 'Tides' },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return [origin, () => { server.close(); server.closeAllConnections?.(); }];
}

describe('a pool of instances instead of one', () => {
  test('a list is parsed, trimmed and stripped of trailing slashes', () => {
    const urls = searxngInstances({ searxngUrl: ' https://a.example/ , https://b.example ,, https://c.example// ' });
    assert.deepEqual(urls, ['https://a.example', 'https://b.example', 'https://c.example']);
  });

  test('a dead instance is stepped over, not fatal', async () => {
    const [disabled, closeA] = await instance('json_disabled');
    const [limited, closeB] = await instance('rate_limited');
    const [good, closeC] = await instance('ok');
    try {
      const urls = await searxng.discover('tidal range', {
        config: makeConfig({ searxngUrl: [disabled, limited, good].join(',') }),
      });
      assert.deepEqual(urls, ['https://example.org/tidal-range', 'https://example.org/tides']);
    } finally { closeA(); closeB(); closeC(); }
  });

  test('an instance that answers with nothing counts as a failure', async () => {
    // A 200 carrying an empty result list is a rate limiter being polite.
    // Accepting it would end the search with no candidates and no error.
    const [limited, closeA] = await instance('rate_limited');
    const [good, closeB] = await instance('ok');
    try {
      const urls = await searxng.discover('tidal range', {
        config: makeConfig({ searxngUrl: `${limited},${good}` }),
      });
      assert.equal(urls.length, 2, 'it moved on to the instance that actually answers');
    } finally { closeA(); closeB(); }
  });

  test('when every instance fails, the error names each one and what it did', async () => {
    const [disabled, closeA] = await instance('json_disabled');
    const [html, closeB] = await instance('html_only');
    try {
      await assert.rejects(
        () => searxng.discover('tidal range', { config: makeConfig({ searxngUrl: `${disabled},${html}` }) }),
        (err) => {
          assert.match(err.message, /JSON API disabled/, 'says which failure each instance had');
          assert.match(err.message, /find-searxng/, 'points at the tool that fixes it');
          assert.equal(err.code, 'searxng_unreachable');
          return true;
        },
      );
    } finally { closeA(); closeB(); }
  });
});

describe('falling back rather than failing', () => {
  test('a provider that cannot answer hands off to one that can', async () => {
    const [dead, close] = await instance('json_disabled');
    try {
      const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
      // The fallback stands in for Wikipedia: it only ever names addresses.
      PROVIDERS.testfallback = {
        id: 'testfallback', label: 'Test fallback', needsKey: false,
        async discover() { return ['https://example.org/from-fallback']; },
      };
      const config = makeConfig({
        webDiscovery: true,
        searchProvider: 'searxng',
        searxngUrl: dead,
        searchFallbackProvider: 'testfallback',
      });
      // No real fetching needed — the handoff is what is under test.
      const discovery = new Discovery(index, config, { log: () => {} });
      discovery.crawler.fetchAll = async (urls) => ({ indexed: urls.length, skipped: 0, errors: 0, remaining: [] });

      const result = await discovery.expand('tidal range');
      assert.equal(result.provider, 'testfallback', 'the fallback answered');
      assert.equal(result.fellBackFrom, 'searxng', 'and it is recorded, not hidden');
      assert.equal(result.added, 1);
    } finally {
      close();
      delete PROVIDERS.testfallback;
    }
  });

  test('with no fallback configured it still fails loudly', async () => {
    const [dead, close] = await instance('json_disabled');
    try {
      const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
      const discovery = new Discovery(index, makeConfig({
        webDiscovery: true, searchProvider: 'searxng', searxngUrl: dead, searchFallbackProvider: '',
      }), { log: () => {} });
      await assert.rejects(() => discovery.expand('tidal range'), /Could not reach/);
    } finally { close(); }
  });
});
