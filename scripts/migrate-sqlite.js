// Move an existing JSON index into SQLite, without touching the original.
//
//   npm run migrate:sqlite
//
// The JSON file is only ever read. If anything goes wrong you still have it,
// and STORAGE=json still runs against it.

import { existsSync, statSync } from 'node:fs';

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { SqliteIndex } from '../src/core/sqlite-index.js';
import { indexPaths } from '../src/storage/open-index.js';

const config = makeConfig();
const paths = indexPaths(config);
const force = process.argv.includes('--force');

if (!existsSync(paths.json)) {
  console.log(`Nothing to migrate — no JSON index at ${paths.json}.`);
  process.exit(0);
}

const source = new SearchIndex(await new JsonStore(config.dataDir, 'index', emptyIndexData()).load());
console.log(`reading ${paths.json} — ${source.docCount} documents, ${source.termCount} terms`);
if (source.docCount === 0) {
  console.log('It is empty. Nothing to do.');
  process.exit(0);
}

const target = new SqliteIndex(paths.sqlite);
if (target.docCount > 0 && !force) {
  console.log(`\n${paths.sqlite} already holds ${target.docCount} documents.`);
  console.log('Re-run with --force to add the JSON documents to it anyway.');
  console.log('(Documents with the same URL are replaced, never duplicated.)');
  target.close();
  process.exit(1);
}

// Re-adding through addDocument re-tokenizes from the stored text rather than
// copying postings across. Slower, and the right call: the two backends then
// hold the same thing by construction, not by my getting a transcription right.
const started = Date.now();
let moved = 0;
for (const id in source.data.docs) {
  const doc = source.data.docs[id];
  if (doc.removed) continue;
  target.addDocument({
    url: doc.url,
    title: doc.title,
    description: doc.description,
    text: doc.text,
    links: doc.links,
    lang: doc.lang,
    fetchedAt: doc.fetchedAt,
  });
  if (++moved % 500 === 0) process.stdout.write(`  ${moved}\r`);
}

console.log(`  ${moved} documents copied — recomputing link authority…`);
target.computeAuthority();
await target.save();

const totals = { docs: target.docCount, terms: target.termCount };
target.close();

const jsonSize = statSync(paths.json).size;
const dbSize = statSync(paths.sqlite).size;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  ${totals.docs} documents, ${totals.terms} terms`);
console.log(`  ${paths.json} ${mb(jsonSize)}  (kept, untouched)`);
console.log(`  ${paths.sqlite} ${mb(dbSize)}`);
console.log('\nSQLite is already the default — just start it:');
console.log('  npm start');
console.log('\nThe difference is what happens at boot: the JSON index loaded every');
console.log('posting into memory, this one reads only the terms a query asks about.');
