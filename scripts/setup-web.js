// Set Northstar up to search the real web, in one command.
//
//   npm run setup:web                        # guided
//   npm run setup:web -- --provider=brave --key=BSA…
//   npm run setup:web -- --provider=wikipedia
//
// Writes .env.local (never committed), then proves it works with a real
// query against the provider and a real fetch of one of the pages it names.

import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { makeConfig } from '../src/config.js';
import { PROVIDERS, PROVIDER_NOTES, getProvider } from '../src/websearch/providers.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Discovery } from '../src/websearch/discovery.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

const ORDER = ['searxng', 'brave', 'wikipedia', 'google', 'bing'];

function printChoices() {
  console.log(`\n${bold('How should Northstar find pages it has never seen?')}\n`);
  console.log(dim('  A provider only ever names candidate URLs. Northstar fetches, indexes'));
  console.log(dim('  and ranks every page itself, so no provider decides your rankings.\n'));
  ORDER.forEach((id, i) => {
    const p = PROVIDERS[id], n = PROVIDER_NOTES[id];
    console.log(`  ${bold(String(i + 1))}. ${p.label}${n.recommended ? ok('   ← recommended') : ''}`);
    console.log(`     ${n.independence}`);
    console.log(`     ${dim(n.cost)}`);
    console.log(`     ${dim(n.signup)}\n`);
  });
}

async function main() {
  let providerId = flag('provider');
  let key = flag('key');
  let cseId = flag('cse');

  const interactive = !providerId && stdin.isTTY;
  let rl = null;
  if (interactive) {
    printChoices();
    rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`Choose 1-${ORDER.length} (or press enter for SearXNG — no key needed): `)).trim();
    providerId = ORDER[(Number(answer) || 1) - 1] || 'searxng';
  }
  providerId ||= 'searxng';

  if (!PROVIDERS[providerId]) {
    console.error(bad(`Unknown provider '${providerId}'. Available: ${ORDER.join(', ')}.`));
    process.exit(1);
  }
  const provider = PROVIDERS[providerId];

  // SearXNG needs a URL rather than a key.
  let searxUrl = flag('url');
  if (providerId === 'searxng' && !searxUrl) {
    if (rl) {
      console.log(`\n${dim('Run your own instance (recommended — no shared limits, nobody else sees your queries):')}`);
      console.log(dim(`  ${PROVIDER_NOTES.searxng.signup}\n`));
      searxUrl = (await rl.question('SearXNG URL [http://localhost:8888]: ')).trim();
    }
    searxUrl ||= 'http://localhost:8888';
  }

  if (provider.needsKey && !key) {
    if (!rl) {
      console.error(bad(`${provider.label} needs a key. Pass --key=… or run without flags to be prompted.`));
      console.error(dim(`  Get one: ${PROVIDER_NOTES[providerId].signup}`));
      process.exit(1);
    }
    console.log(`\n${dim(`Get a key here: ${PROVIDER_NOTES[providerId].signup}`)}`);
    key = (await rl.question(`Paste your ${provider.label} API key: `)).trim();
  }
  if (providerId === 'google' && !cseId) {
    if (rl) cseId = (await rl.question('Paste your Google CSE id (cx): ')).trim();
    if (!cseId) {
      console.error(bad('Google Programmable Search also needs --cse=<id>.'));
      process.exit(1);
    }
  }
  await rl?.close();

  // ── Write .env.local ────────────────────────────────────────────────
  const keyVar = { brave: 'BRAVE_API_KEY', google: 'GOOGLE_API_KEY', bing: 'BING_API_KEY' }[providerId];
  const lines = ['# Written by `npm run setup:web`. Keep this file out of git.',
    'WEB_DISCOVERY=1', `SEARCH_PROVIDER=${providerId}`];
  if (keyVar && key) lines.push(`${keyVar}=${key}`);
  if (cseId) lines.push(`GOOGLE_CSE_ID=${cseId}`);
  if (searxUrl) lines.push(`SEARXNG_URL=${searxUrl}`);

  const envPath = new URL('../.env.local', import.meta.url);
  let existing = '';
  try { existing = await readFile(envPath, 'utf8'); } catch {}
  const kept = existing.split('\n').filter((l) => {
    const k = l.split('=')[0];
    return l.trim() && !l.startsWith('#')
      && !['WEB_DISCOVERY', 'SEARCH_PROVIDER', 'BRAVE_API_KEY', 'GOOGLE_API_KEY',
           'BING_API_KEY', 'GOOGLE_CSE_ID', 'SEARXNG_URL'].includes(k);
  });
  await writeFile(envPath, [...lines, ...kept].join('\n') + '\n', 'utf8');
  console.log(`\n${ok('✓')} wrote .env.local (${providerId}${key ? ' + key' : ''})`);

  // ── Prove it actually works ─────────────────────────────────────────
  const config = makeConfig({
    webDiscovery: true,
    searchProvider: providerId,
    searchApiKey: key || null,
    searchEngineId: cseId || null,
    ...(searxUrl ? { searxngUrl: searxUrl } : {}),
  });
  try {
    getProvider(config);
  } catch (err) {
    console.error(`\n${bad('✗')} ${err.message}`);
    process.exit(1);
  }

  const probe = 'polaris navigation';
  console.log(`\nasking ${provider.label} for candidate URLs for ${bold(`"${probe}"`)} …`);
  let urls = [];
  try {
    urls = await provider.discover(probe, { limit: 4, config });
  } catch (err) {
    console.error(`\n${bad('✗')} the provider did not answer: ${err.message}`);
    console.error(dim('  Check the key, and whether outbound HTTPS is allowed from this machine.'));
    console.error(dim('  Behind a proxy? Run with NODE_USE_ENV_PROXY=1.'));
    process.exit(1);
  }
  if (urls.length === 0) {
    console.error(`\n${bad('✗')} the provider answered but named no URLs. Check the account/plan.`);
    process.exit(1);
  }
  console.log(`${ok('✓')} it named ${urls.length} URLs, e.g. ${dim(urls[0])}`);

  console.log('\nfetching and indexing one of them, the way a real search would …');
  const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
  const discovery = new Discovery(index, { ...config, discoveryLimit: 2, discoveryBudgetMs: 20000 });
  const result = await discovery.expand(probe, { limit: 2 });

  if (result.added > 0) {
    const doc = index.sampleDocument();
    console.log(`${ok('✓')} indexed ${result.added} page(s) — e.g. ${bold(doc.title || doc.url)}`);
    console.log(`\n${ok(bold('Northstar can search the web.'))}`);
    console.log(`\nStart it:      ${bold('npm start')}`);
    console.log(`Build a base:  ${bold('npm run bootstrap')}   ${dim('(a real index of your own, no per-query cost)')}`);
    console.log(`Check health:  ${bold('npm run doctor')}`);
  } else {
    console.log(`${bad('✗')} nothing could be fetched (skipped ${result.skipped}, errors ${result.errors}).`);
    console.log(dim('  The provider works, but page fetching does not. Usually a proxy or firewall.'));
    console.log(dim('  Try: NODE_USE_ENV_PROXY=1 npm run doctor'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(bad(`\nsetup failed: ${err.message}`));
  process.exit(1);
});
