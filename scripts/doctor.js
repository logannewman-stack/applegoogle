// Diagnose web search, top to bottom.
//
//   npm run doctor
//   NODE_USE_ENV_PROXY=1 npm run doctor     # behind a proxy
//
// Every check says what it found and, when it fails, exactly what to do.

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Discovery } from '../src/websearch/discovery.js';
import { PROVIDERS, PROVIDER_NOTES } from '../src/websearch/providers.js';
import { RobotsCache } from '../src/crawler/robots.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const results = [];
const pass = (name, detail) => { results.push(true); console.log(`${ok('✓')} ${name}${detail ? dim(`  ${detail}`) : ''}`); };
const fail = (name, detail, fix) => {
  results.push(false);
  console.log(`${bad('✗')} ${name}${detail ? dim(`  ${detail}`) : ''}`);
  if (fix) console.log(`  ${dim('→')} ${fix}`);
};
const note = (name, detail) => console.log(`${warn('•')} ${name}${detail ? dim(`  ${detail}`) : ''}`);

const config = makeConfig();
console.log(bold('\nNorthstar — web search diagnosis\n'));

// ── 1. The index itself ────────────────────────────────────────────────
const store = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
const index = new SearchIndex(store);
if (index.docCount === 0) {
  fail('Index is empty', 'nothing to search', 'npm run seed   (sample corpus)  ·  npm run bootstrap   (real pages)');
} else if (index.docCount < 50) {
  note(`Index holds ${index.docCount} documents`, 'small — fine for a demo, thin for real use');
  console.log(`  ${dim('→')} npm run bootstrap   to crawl real pages`);
} else {
  pass(`Index holds ${index.docCount} documents`, `${index.termCount} terms`);
}

// ── 2. Outbound network ────────────────────────────────────────────────
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy && process.env.NODE_USE_ENV_PROXY !== '1') {
  note('A proxy is set but Node is not using it', proxy);
  console.log(`  ${dim('→')} prefix commands with NODE_USE_ENV_PROXY=1`);
}
let netOk = false;
try {
  const res = await fetch('https://en.wikipedia.org/robots.txt', { signal: AbortSignal.timeout(8000) });
  netOk = res.ok;
  netOk ? pass('Outbound HTTPS works', 'reached en.wikipedia.org')
        : fail('Outbound HTTPS blocked', `wikipedia answered ${res.status}`, 'check firewall/proxy');
} catch (err) {
  fail('Outbound HTTPS blocked', err.message,
    proxy ? 'try NODE_USE_ENV_PROXY=1 npm run doctor' : 'Northstar cannot crawl without outbound HTTPS');
}

// ── 3. Discovery configuration ─────────────────────────────────────────
if (!config.webDiscovery) {
  note('Live discovery is off', 'Northstar will only answer from its own index');
  console.log(`  ${dim('→')} npm run setup:web    to turn it on`);
} else {
  const provider = PROVIDERS[config.searchProvider];
  if (!provider) {
    fail('Unknown SEARCH_PROVIDER', config.searchProvider, `use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  } else if (provider.needsKey && !config.searchApiKey) {
    fail(`${provider.label} has no API key`, '', `set ${provider.keyEnv} — see ${PROVIDER_NOTES[config.searchProvider]?.signup}`);
  } else {
    pass(`Provider configured`, provider.label);
    if (provider.retired) note('That provider is retired upstream', 'verify it still answers for your account');

    // ── 4. Does the provider actually answer? ──────────────────────────
    if (netOk) {
      try {
        const urls = await provider.discover('polaris navigation', { limit: 3, config });
        urls.length > 0
          ? pass('Provider answers', `named ${urls.length} URLs, e.g. ${urls[0]}`)
          : fail('Provider answered with no URLs', '', 'check the account, plan or quota');

        // ── 5. Full round trip: fetch, index, rank ───────────────────
        if (urls.length > 0) {
          const probe = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
          const d = new Discovery(probe, { ...config, discoveryBudgetMs: 20000 });
          const r = await d.expand('polaris navigation', { limit: 2 });
          r.added > 0
            ? pass('Full round trip works', `fetched and indexed ${r.added} page(s) in ${r.tookMs}ms`)
            : fail('Pages could not be fetched', `skipped ${r.skipped}, errors ${r.errors}`,
                'the provider works but crawling does not — usually a proxy, firewall, or robots.txt');
        }
      } catch (err) {
        fail('Provider request failed', err.message,
          err.status === 401 || err.status === 403 ? 'the API key looks wrong or expired' : 'check connectivity and quota');
      }
    }
  }
}

// ── 6. Politeness sanity ───────────────────────────────────────────────
if (netOk) {
  try {
    const robots = new RobotsCache({ userAgent: config.crawlUserAgent, timeoutMs: 8000 });
    const allowed = await robots.isAllowed('https://en.wikipedia.org/wiki/Polaris');
    const denied = await robots.isAllowed('https://en.wikipedia.org/w/index.php?title=X&action=edit');
    allowed && !denied
      ? pass('robots.txt is parsed and obeyed', 'article allowed, edit path disallowed')
      : note('robots.txt parsed', `article=${allowed} editPath=${denied} — verify manually if this looks wrong`);
  } catch { note('Could not check robots.txt', 'network issue'); }
}
if (config.crawlDelayMs < 500) {
  note(`Crawl delay is ${config.crawlDelayMs}ms`, 'below 1s per host is impolite for public sites');
}

// ── Summary ────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r).length;
console.log('');
if (failed === 0) {
  console.log(ok(bold('Everything checks out.')));
  if (!config.webDiscovery) console.log(dim('(Discovery is off — that is a choice, not a fault.)'));
} else {
  console.log(bad(bold(`${failed} check${failed === 1 ? '' : 's'} failed.`)) + dim('  Fixes are listed above.'));
}
console.log('');
process.exit(failed === 0 ? 0 : 1);
