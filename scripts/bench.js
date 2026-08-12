// Does the ceiling actually move? Build the same synthetic corpus in both
// backends and measure what boot, memory and a query cost.
//
//   npm run bench -- --docs=20000
//
// The corpus is generated rather than crawled so the comparison is about
// storage and nothing else.

import { rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { SqliteIndex } from '../src/core/sqlite-index.js';
import { JsonStore } from '../src/storage/store.js';
import { search } from '../src/core/ranker.js';

const arg = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d);
const DOCS = arg('docs', 20000);

const COMMON = ('tidal range moon gravity ocean harbour estuary current sediment coastline navigation '
  + 'chart compass bearing latitude longitude sextant horizon meridian almanac drift '
  + 'coffee espresso grind bloom extraction roast filter brewing kettle pressure').split(' ');

const rnd = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// Real text is Zipfian: a few words everywhere, a long tail almost nowhere.
// A corpus of thirty words is not a hard test, it is a broken one — every
// document matches every query, so the pool is the whole index and the
// measurement says nothing about how search actually behaves. `--realistic`
// draws from a large vocabulary with a Zipf-like bias so the numbers mean
// something; the default keeps the pathological case, because the worst case
// is worth knowing too.
const REALISTIC = process.argv.includes('--realistic');
const VOCAB = REALISTIC
  ? [...COMMON, ...Array.from({ length: 30000 }, (_, i) => `term${i}`)]
  : COMMON;

function zipf(random) {
  // Heavily favours the front of the vocabulary, where the common words are.
  return Math.min(VOCAB.length - 1, Math.floor(VOCAB.length * random() ** 6));
}

function makeDoc(i, random) {
  const pick = (n) => Array.from({ length: n },
    () => VOCAB[REALISTIC ? zipf(random) : Math.floor(random() * VOCAB.length)]).join(' ');
  return {
    url: `https://site${i % 500}.example/page-${i}`,
    title: pick(6),
    description: pick(12),
    text: pick(300),
    links: i % 7 === 0 ? [`https://site${(i + 1) % 500}.example/page-${(i + 3) % DOCS}`] : [],
    fetchedAt: '2026-08-01T00:00:00.000Z',
  };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };

const dir = join(tmpdir(), `northstar-bench-${DOCS}`);
rmSync(dir, { recursive: true, force: true });

const QUERIES = ['tidal range', 'coffee grind pressure', 'moon gravity ocean', 'sextant horizon meridian'];

async function run(label, build, save, reopen, path) {
  const baseline = heap();
  let t = Date.now();
  const index = build();
  const random = rnd(42);
  for (let i = 0; i < DOCS; i++) index.addDocument(makeDoc(i, random));
  const buildMs = Date.now() - t;

  t = Date.now();
  await save(index);
  const saveMs = Date.now() - t;
  const size = existsSync(path) ? statSync(path).size : 0;

  // Boot cost is what actually caps the index: how much has to be read, and
  // held, before the first query can be answered.
  t = Date.now();
  const fresh = await reopen();
  const bootMs = Date.now() - t;
  const bootHeap = heap() - baseline;

  t = Date.now();
  let hits = 0;
  const tops = [];
  for (let i = 0; i < 25; i++) {
    const r = search(fresh, QUERIES[i % QUERIES.length], { perPage: 10 });
    hits += r.total;
    if (i < QUERIES.length) tops.push(r.results.map((x) => x.url));
  }
  const queryMs = (Date.now() - t) / 25;

  fresh.close?.();
  index.close?.();
  return { label, buildMs, saveMs, size, bootMs, bootHeap, queryMs, hits, tops };
}

console.log(`building ${DOCS.toLocaleString()} documents in each backend`
  + ` (${REALISTIC ? `realistic: ${VOCAB.length.toLocaleString()}-word Zipfian vocabulary` : `worst case: ${VOCAB.length}-word vocabulary, everything matches everything`})\n`);

const jsonPath = join(dir, 'json', 'index.json');
const json = await run('JSON  ',
  () => new SearchIndex(new JsonStore(join(dir, 'json'), 'index', emptyIndexData())),
  async (i) => i.save(),
  async () => new SearchIndex(await new JsonStore(join(dir, 'json'), 'index', emptyIndexData()).load()),
  jsonPath);

const dbPath = join(dir, 'sqlite', 'index.db');
const sqlite = await run('SQLite',
  () => new SqliteIndex(dbPath),
  async (i) => i.save(),
  async () => new SqliteIndex(dbPath),
  dbPath);

const row = (r) => `${r.label}  ${String(Math.round(r.buildMs / 1000) + 's').padStart(6)}  `
  + `${mb(r.size).padStart(8)}  ${String(r.bootMs + 'ms').padStart(8)}  `
  + `${mb(r.bootHeap).padStart(9)}  ${(r.queryMs.toFixed(1) + 'ms').padStart(8)}`;

console.log('backend    build      size     boot   boot RAM     query');
console.log('─'.repeat(60));
console.log(row(json));
console.log(row(sqlite));
console.log('─'.repeat(60));
console.log(`\nboot: ${(json.bootMs / Math.max(1, sqlite.bootMs)).toFixed(1)}× faster, `
  + `boot RAM: ${(json.bootHeap / Math.max(1, sqlite.bootHeap)).toFixed(1)}× smaller`);
// The number that matters is not how many pages matched but which ones ranked.
// SQLite caps how many documents a single term may contribute, so on a corpus
// where every word is in every document the totals differ by design. If the
// pages people actually see differ, that is a bug, not a trade.
const agree = json.tops.every((urls, i) => JSON.stringify(urls) === JSON.stringify(sqlite.tops[i]));
console.log(`\ntop 10 identical across all ${QUERIES.length} queries: ${agree ? 'yes' : 'NO — that is a bug'}`);
console.log(`total matches counted: JSON ${json.hits.toLocaleString()}, SQLite ${sqlite.hits.toLocaleString()}`
  + `${json.hits === sqlite.hits ? '' : ' (SQLite caps documents per term; the weakest evidence is dropped, never the strongest)'}`);
console.log(`\nProjected at 1,000,000 documents:`);
console.log(`  JSON   ${mb(json.size / DOCS * 1e6)} read into memory before the first query`);
console.log(`  SQLite ${mb(sqlite.size / DOCS * 1e6)} on disk, ${mb(sqlite.bootHeap)} in memory — boot cost does not grow`);

rmSync(dir, { recursive: true, force: true });
