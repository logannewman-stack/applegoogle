// Central configuration. Everything is overridable via environment variables,
// and programmatically via `overrides` (used by tests).

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function makeConfig(overrides = {}) {
  const env = process.env;
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || new URL('../data/', import.meta.url).pathname,

    // Northstar is free right now — no tiers, no premium anything. The one
    // limit is a high fair-use ceiling, identical for everyone, that exists
    // purely to stop abuse. (The eventual business model is a subscription —
    // never advertising.)
    dailyFairUseCeiling: num(env.DAILY_FAIR_USE_CEILING, 2000),

    // Set to true only when running behind a reverse proxy that sets X-Forwarded-For.
    trustProxy: env.TRUST_PROXY === '1',

    // Crawler politeness
    crawlUserAgent: env.CRAWL_USER_AGENT || 'northstar-crawler/0.2 (respectful; obeys robots.txt)',
    crawlDelayMs: num(env.CRAWL_DELAY_MS, 1000),
    crawlTimeoutMs: num(env.CRAWL_TIMEOUT_MS, 10000),
    crawlMaxBytes: num(env.CRAWL_MAX_BYTES, 2 * 1024 * 1024),

    ...overrides,
  };
}
