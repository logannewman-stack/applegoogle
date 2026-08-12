// Load the bundled sample documents so search works immediately, offline.
// Usage: npm run seed

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { seedIndex } from '../src/storage/corpus.js';

const config = makeConfig();
const store = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
const index = new SearchIndex(store);

const count = await seedIndex(index);
await index.save();

console.log(`seeded ${count} documents (${index.docCount} total in index, ${index.termCount} terms)`);
console.log(`data dir: ${config.dataDir}`);
console.log('try: npm start  →  http://127.0.0.1:3000/?q=pour+over+coffee');
