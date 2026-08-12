// Build a real index in one command.
//
//   npm run bootstrap                 # crawl the curated starter sites
//   npm run bootstrap -- --pages=400  # go deeper
//   npm run bootstrap -- --topic=code
//
// These are real, well-behaved, crawlable sites that publish reference-quality
// material and permit crawling in robots.txt. The crawler stays polite either
// way: it re-checks robots.txt itself, waits between hits, and honors noindex.
//
// Behind a proxy, prefix with NODE_USE_ENV_PROXY=1 so Node's fetch uses it.

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { Crawler } from '../src/crawler/crawler.js';

const TOPICS = {
  code: [
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',
    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout',
    'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
  ],
  reference: [
    'https://en.wikipedia.org/wiki/Search_engine',
    'https://en.wikipedia.org/wiki/Polaris',
    'https://en.wikipedia.org/wiki/Celestial_navigation',
    'https://en.wikipedia.org/wiki/Information_retrieval',
  ],
  science: [
    'https://en.wikipedia.org/wiki/Light_pollution',
    'https://en.wikipedia.org/wiki/Coffee_preparation',
    'https://en.wikipedia.org/wiki/Sourdough',
  ],
  standards: [
    'https://www.rfc-editor.org/rfc/rfc9309.html',
    'https://www.w3.org/TR/WCAG22/',
  ],
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const topic = flag('topic', null);
const maxPages = Number(flag('pages', 120));
const maxDepth = Number(flag('depth', 2));

const seeds = topic
  ? (TOPICS[topic] || [])
  : Object.values(TOPICS).flat();

if (seeds.length === 0) {
  console.error(`Unknown topic '${topic}'. Available: ${Object.keys(TOPICS).join(', ')}.`);
  process.exit(1);
}

const config = makeConfig();
const store = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
const index = new SearchIndex(store);
const crawler = new Crawler(index, config, { log: (m) => console.log(`  ${m}`) });

console.log(`bootstrapping from ${seeds.length} seed pages — up to ${maxPages} pages, depth ${maxDepth}`);
console.log('(robots.txt is obeyed, one request per host per second)\n');

const before = index.docCount;
const stats = await crawler.crawl(seeds, { maxPages, maxDepth, sameDomain: true });
await index.save();

console.log(`\nindexed ${stats.indexed} new pages (${stats.fetched} fetched, ${stats.skipped} skipped, ${stats.errors} errors)`);
console.log(`index: ${before} → ${index.docCount} documents, ${index.termCount} terms`);
if (stats.errors > 0 && stats.indexed === 0) {
  console.log('\nEverything failed to fetch. If you are behind a proxy, retry with:');
  console.log('  NODE_USE_ENV_PROXY=1 npm run bootstrap');
}
