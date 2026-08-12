// Find public SearXNG instances that will actually answer Northstar.
//
//   npm run find-searxng
//
// Most public instances serve HTML to humans and switch the JSON API off, so
// picking one off a list is a coin flip. This asks each one a real question
// and keeps only the ones that answer, then prints the exact line to paste
// into .env.local or Vercel's environment variables.
//
// It probes in parallel and never writes anything — run it any time an
// instance goes quiet.

import { makeConfig } from '../src/config.js';

const config = makeConfig();
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PROBE_QUERY = arg('q', 'tidal range explained');
const WANT = Number(arg('want', 5));
const TIMEOUT_MS = Number(arg('timeout', 8000));

// searx.space publishes the instance list. If it is unreachable (offline, or
// a network that blocks it) we still have somewhere to start.
const FALLBACK_LIST = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searxng.site',
  'https://search.inetol.net',
  'https://priv.au',
  'https://searx.tiekoetter.com',
  'https://search.rhscz.eu',
  'https://opnxng.com',
  'https://search.hbubli.cc',
  'https://baresearch.org',
];

async function instanceList() {
  try {
    const res = await fetch('https://searx.space/data/instances.json', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const urls = Object.keys(data.instances || {})
      // Onion and i2p addresses need a proxy Northstar does not have.
      .filter((u) => u.startsWith('https://') && !u.includes('.onion') && !u.includes('.i2p'));
    if (urls.length === 0) throw new Error('no instances listed');
    console.log(`searx.space lists ${urls.length} instances — probing them.\n`);
    return urls;
  } catch (err) {
    console.log(`could not read searx.space (${err.message}) — probing a built-in list instead.\n`);
    return FALLBACK_LIST;
  }
}

// One instance, one real query. Anything short of usable URLs is a failure.
async function probe(base) {
  const url = `${base.replace(/\/+$/, '')}/search`
    + `?q=${encodeURIComponent(PROBE_QUERY)}&format=json&language=en&safesearch=0`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'northstar-discovery/0.3 (+https://github.com/logannewman-stack/applegoogle)',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { base, ok: false, why: res.status === 403 || res.status === 404 ? 'JSON API disabled' : `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return { base, ok: false, why: 'served HTML, not JSON' };
    const data = await res.json();
    const urls = (data?.results || []).map((r) => r.url).filter(Boolean);
    if (urls.length === 0) return { base, ok: false, why: 'answered with no results (rate limited?)' };
    return { base, ok: true, count: urls.length, ms: Date.now() - started, sample: urls[0] };
  } catch (err) {
    const why = /timeout|abort/i.test(err.message) ? `no answer in ${TIMEOUT_MS}ms` : err.message;
    return { base, ok: false, why };
  }
}

// Bounded concurrency: polite to the instances, and fast enough to be useful.
async function probeAll(urls, concurrency = 12) {
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const result = await probe(url);
      results.push(result);
      process.stdout.write(result.ok ? '✓' : '·');
    }
  }));
  process.stdout.write('\n\n');
  return results;
}

const candidates = await instanceList();
const results = await probeAll(candidates);
const working = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);

if (working.length === 0) {
  console.log('No public instance answered with JSON.\n');
  console.log('This is normal — the JSON API is off by default and most operators');
  console.log('leave it off. Run your own instead. One command, no rate limit,');
  console.log('and nobody else sees your queries:\n');
  console.log('  docker compose up -d');
  console.log('  npm run setup:web -- --provider=searxng --url=http://localhost:8888\n');
  process.exit(1);
}

console.log(`${working.length} instance(s) answered:\n`);
for (const r of working.slice(0, 12)) {
  console.log(`  ${String(r.ms).padStart(5)}ms  ${r.base.padEnd(38)} ${r.count} URLs — e.g. ${r.sample.slice(0, 48)}`);
}

const chosen = working.slice(0, WANT).map((r) => r.base);
console.log(`\nFastest ${chosen.length}, as one setting. Northstar tries them in order and`);
console.log('stops at the first that answers, so one going down costs you nothing:\n');
console.log(`  SEARXNG_URL=${chosen.join(',')}\n`);
console.log('Locally:');
console.log(`  npm run setup:web -- --provider=searxng --url="${chosen.join(',')}"\n`);
console.log('On Vercel — Settings → Environment Variables, then redeploy:');
console.log('  SEARCH_PROVIDER = searxng');
console.log(`  SEARXNG_URL     = ${chosen.join(',')}\n`);

if (config.ephemeral) {
  console.log('Note: these were probed from this machine. A datacenter IP (Vercel) is');
  console.log('blocked by some instances even when your laptop is not.\n');
}
