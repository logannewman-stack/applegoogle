// Load the bundled sample documents so search works immediately, offline.
// Usage: npm run seed

import { readFile } from 'node:fs/promises';

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';

const config = makeConfig();
const store = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
const index = new SearchIndex(store);

const seedsPath = new URL('../seeds/sample-docs.json', import.meta.url);
const docs = JSON.parse(await readFile(seedsPath, 'utf8'));

const fetchedAt = new Date().toISOString();
for (const doc of docs) {
  index.addDocument({ ...doc, fetchedAt });
}
index.computeAuthority();
await index.save();

console.log(`seeded ${docs.length} documents (${index.docCount} total in index, ${index.termCount} terms)`);
console.log(`data dir: ${config.dataDir}`);
console.log('try: npm start  →  http://127.0.0.1:3000/?q=pour+over+coffee');
