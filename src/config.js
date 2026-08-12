// Central configuration. Everything is overridable via environment variables,
// and programmatically via `overrides` (used by tests).

import { readFileSync } from 'node:fs';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Load .env.local / .env if present. A variable already set in the real
// environment always wins — a file must never override an explicit export.
function loadEnvFiles() {
  for (const name of ['.env.local', '.env']) {
    let text;
    try { text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key in process.env) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
loadEnvFiles();

// A serverless host (Vercel and friends) gives you a read-only project
// directory and a /tmp that dies with the instance. Northstar still works
// there — it boots from the bundled corpus and reads the live web for every
// query — but nothing it learns is kept, so several defaults have to change:
// write to /tmp, build the index on boot, trust the proxy's forwarded IP, and
// use a provider that needs no container running next door.
const isEphemeralHost = () => process.env.VERCEL === '1' || process.env.NORTHSTAR_EPHEMERAL === '1';

// For flags where "unset" and "explicitly off" must stay distinguishable.
const flag = (v, fallback) => (v === undefined || v === '' ? fallback : v === '1');

export function makeConfig(overrides = {}) {
  const env = process.env;
  const ephemeral = isEphemeralHost();
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || (ephemeral ? '/tmp/northstar/' : new URL('../data/', import.meta.url).pathname),

    // True when the disk will not outlive the process. Surfaced through the
    // API so the app can say so plainly, rather than letting someone build up
    // a history that quietly disappears.
    ephemeral,
    // Build the index from seeds/ whenever the store comes up empty.
    seedWhenEmpty: flag(env.SEED_WHEN_EMPTY, ephemeral),

    // Northstar is free right now — no tiers, no premium anything. The one
    // limit is a high fair-use ceiling, identical for everyone, that exists
    // purely to stop abuse. (The eventual business model is a subscription —
    // never advertising.)
    dailyFairUseCeiling: num(env.DAILY_FAIR_USE_CEILING, 2000),

    // Set to true only when running behind a reverse proxy that sets
    // X-Forwarded-For — which a serverless host always is.
    trustProxy: flag(env.TRUST_PROXY, ephemeral),

    // Live web discovery — off unless asked for, because it reaches the
    // network. On a deployed host it is the whole point, so it defaults on
    // there: without it a public Northstar could only search its own seeds.
    // When on, a provider supplies candidate URLs for queries the local index
    // answers poorly, and Northstar fetches, indexes and ranks them itself.
    webDiscovery: flag(env.WEB_DISCOVERY, ephemeral),
    // SearXNG is the best local default (keyless, whole web) but it is a
    // container on your own machine, and a serverless function has no
    // neighbour to talk to. There, fall back to the keyless hosted option.
    searchProvider: env.SEARCH_PROVIDER || (ephemeral ? 'wikipedia' : 'searxng'),
    searxngUrl: env.SEARXNG_URL || 'http://localhost:8888',
    searchApiKey: env.BRAVE_API_KEY || env.GOOGLE_API_KEY || env.BING_API_KEY || env.SEARCH_API_KEY || null,
    searchEngineId: env.GOOGLE_CSE_ID || null,
    wikipediaHost: env.WIKIPEDIA_HOST || 'en.wikipedia.org',
    discoveryLimit: num(env.DISCOVERY_LIMIT, 6), //  candidate URLs per expansion
    discoveryMinResults: num(env.DISCOVERY_MIN_RESULTS, 3), // expand when fewer than this
    // …and also when what we do have is weak. Without this, a handful of
    // barely-relevant local pages would suppress the expansion that a query
    // about anything outside the index actually needs.
    discoveryMinScore: num(env.DISCOVERY_MIN_SCORE, 1.6),
    discoveryCooldownMs: num(env.DISCOVERY_COOLDOWN_MS, 6 * 60 * 60 * 1000),
    // How long a search may wait for new pages before answering with what it
    // has; anything slower keeps loading in the background.
    discoveryBudgetMs: num(env.DISCOVERY_BUDGET_MS, 2500),

    // Crawler politeness
    crawlUserAgent: env.CRAWL_USER_AGENT || 'northstar-crawler/0.3 (respectful; obeys robots.txt)',
    crawlDelayMs: num(env.CRAWL_DELAY_MS, 1000),
    crawlTimeoutMs: num(env.CRAWL_TIMEOUT_MS, 10000),
    crawlMaxBytes: num(env.CRAWL_MAX_BYTES, 2 * 1024 * 1024),

    ...overrides,
  };
}
