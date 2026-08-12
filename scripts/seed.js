// Load the bundled sample documents so search works immediately, offline.
// Usage: npm run seed

import { makeConfig } from '../src/config.js';
import { openIndex } from '../src/storage/open-index.js';
import { seedIndex } from '../src/storage/corpus.js';

const config = makeConfig();
const indexHandle = await openIndex(config, { log: (m) => console.log(m) });
const index = indexHandle.index;

const count = await seedIndex(index);
await index.save();
const totals = { docs: index.docCount, terms: index.termCount };
await indexHandle.close();

console.log(`seeded ${count} documents (${totals.docs} total in index, ${totals.terms} terms)`);
console.log(`data dir: ${config.dataDir}`);
console.log('try: npm start  →  http://127.0.0.1:3000/?q=pour+over+coffee');
