// The bundled corpus.
//
// Two callers need it. `npm run seed` writes it to disk once. A serverless
// instance has no disk that survives, so it builds the same index in memory
// on cold start — otherwise the first visitor to a fresh instance would be
// searching nothing at all.

import { readFile } from 'node:fs/promises';

const FILES = ['sample-docs.json', 'extra-docs.json'];

export async function loadSeedDocs() {
  const docs = [];
  for (const file of FILES) {
    const path = new URL(`../../seeds/${file}`, import.meta.url);
    docs.push(...JSON.parse(await readFile(path, 'utf8')));
  }
  return docs;
}

// Fill an index from the bundled corpus. Returns the number of documents
// added. Link authority is recomputed so the seeded pages rank against each
// other the same way crawled pages do.
export async function seedIndex(index, { now = new Date() } = {}) {
  const docs = await loadSeedDocs();
  const fetchedAt = now.toISOString();
  for (const doc of docs) index.addDocument({ ...doc, fetchedAt });
  index.computeAuthority();
  return docs.length;
}
