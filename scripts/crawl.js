// Crawl real pages into the index.
//
// Usage:
//   npm run crawl -- https://example.com [more urls…] [--max-pages=50] [--depth=2] [--all-domains]
//
// Behind an egress proxy, let Node's fetch use it:
//   NODE_USE_ENV_PROXY=1 npm run crawl -- https://example.com

import { makeConfig } from '../src/config.js';
import { openIndex } from '../src/storage/open-index.js';
import { Crawler } from '../src/crawler/crawler.js';

const args = process.argv.slice(2);
const seeds = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

if (seeds.length === 0) {
  console.error('usage: npm run crawl -- <url> [more urls…] [--max-pages=50] [--depth=2] [--all-domains]');
  process.exit(1);
}

const maxPages = Number(flag('max-pages', 50));
const maxDepth = Number(flag('depth', 2));
const sameDomain = !args.includes('--all-domains');

const config = makeConfig();
const indexHandle = await openIndex(config, { log: (m) => console.log(m) });
const index = indexHandle.index;
const crawler = new Crawler(index, config, { log: (msg) => console.log(`  ${msg}`) });

console.log(`crawling ${seeds.length} seed(s) — up to ${maxPages} pages, depth ${maxDepth}, ${sameDomain ? 'same-domain only' : 'following external links'}`);
const stats = await crawler.crawl(seeds, { maxPages, maxDepth, sameDomain });
await index.save();
const totals = { docs: index.docCount, terms: index.termCount };
await indexHandle.close();

console.log(`\ndone: ${stats.indexed} indexed, ${stats.fetched} fetched, ${stats.skipped} skipped, ${stats.errors} errors`);
console.log(`index now holds ${totals.docs} documents, ${totals.terms} terms`);
