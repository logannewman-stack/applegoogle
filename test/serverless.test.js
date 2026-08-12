// Running where the disk does not survive.
//
// On Vercel (and any host like it) the project directory is read-only, /tmp
// dies with the instance, and there is no container next door to run SearXNG.
// Northstar has to come up searching anyway, and it has to say plainly that
// nothing it learns will be kept.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeConfig } from '../src/config.js';
import { createApp } from '../src/api/app.js';

describe('ephemeral hosts', () => {
  const saved = {};
  const KEYS = ['VERCEL', 'NORTHSTAR_EPHEMERAL', 'WEB_DISCOVERY', 'SEARCH_PROVIDER', 'TRUST_PROXY', 'DATA_DIR', 'SEED_WHEN_EMPTY'];

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('a normal machine keeps its old defaults', () => {
    const config = makeConfig();
    assert.equal(config.ephemeral, false);
    assert.equal(config.webDiscovery, false, 'reaching the network stays opt-in locally');
    assert.equal(config.searchProvider, 'searxng');
    assert.equal(config.trustProxy, false);
    assert.equal(config.seedWhenEmpty, false);
    assert.ok(!config.dataDir.startsWith('/tmp/'), 'local data is kept next to the project');
  });

  test('Vercel flips the defaults that would otherwise make it useless', () => {
    process.env.VERCEL = '1';
    const config = makeConfig();
    assert.equal(config.ephemeral, true);
    assert.equal(config.dataDir, '/tmp/northstar/', 'the only writable path');
    assert.equal(config.seedWhenEmpty, true, 'a cold start must not answer with an empty index');
    assert.equal(config.webDiscovery, true, 'a deployment that cannot reach the web is a demo, not a search engine');
    assert.equal(config.searchProvider, 'wikipedia', 'no container next door to run SearXNG');
    assert.equal(config.trustProxy, true, 'rate limiting must see the real client, not the edge');
  });

  test('an explicit setting always beats the host default', () => {
    process.env.VERCEL = '1';
    process.env.WEB_DISCOVERY = '0';
    process.env.SEARCH_PROVIDER = 'brave';
    process.env.DATA_DIR = '/tmp/somewhere-else/';
    const config = makeConfig();
    assert.equal(config.webDiscovery, false, 'turning discovery off must actually turn it off');
    assert.equal(config.searchProvider, 'brave');
    assert.equal(config.dataDir, '/tmp/somewhere-else/');
    assert.equal(config.ephemeral, true, 'the host is still what it is');
  });
});

describe('a cold start with no disk', () => {
  let app;
  let dataDir;

  beforeEach(async () => {
    // A directory that exists but holds nothing — exactly what a fresh
    // serverless instance sees in /tmp.
    dataDir = await mkdtemp(join(tmpdir(), 'northstar-cold-'));
    app = await createApp({ dataDir, ephemeral: true, seedWhenEmpty: true, webDiscovery: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('comes up with a real index and answers the first query', async () => {
    assert.ok(app.index.docCount > 20, `expected the bundled corpus, got ${app.index.docCount} documents`);

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const res = await fetch(`${base}/v1/search?q=pour+over+coffee`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(body.results.length > 0, 'the first visitor to a fresh instance gets results');
    assert.ok(body.results[0].why.reasons.length > 0, 'and the reasoning that comes with them');
  });

  test('says plainly that nothing here is kept', async () => {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.storage, 'ephemeral');

    const stats = await (await fetch(`${base}/v1/stats`)).json();
    assert.equal(stats.storage.durable, false);
    assert.match(stats.storage.note, /only as long as this instance/i);
  });

  test('serves requests without ever owning a socket', async () => {
    // This is the path Vercel takes: it owns the socket and hands us the
    // pair. Nothing may depend on server.listen() having been called.
    assert.equal(typeof app.handleRequest, 'function');

    const http = await import('node:http');
    const server = http.createServer(app.handleRequest);
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
