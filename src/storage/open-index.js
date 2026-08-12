// Choosing a storage engine, and never losing an index to the choice.
//
// SQLite is the default because the JSON store's ceiling is memory: it loads
// every posting at boot, which stops being reasonable somewhere around thirty
// thousand pages. JSON stays available — it needs no schema and is trivially
// inspectable, which is worth something for tests and small local runs.
//
// The one rule: switching engines must never silently lose an index someone
// spent hours crawling. If SQLite comes up empty while a JSON index sits next
// to it, that is said out loud rather than quietly starting from nothing.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { JsonStore } from './store.js';
import { SearchIndex, emptyIndexData } from '../core/index.js';
import { SqliteIndex } from '../core/sqlite-index.js';

export function indexPaths(config) {
  return {
    sqlite: join(config.dataDir, 'index.db'),
    json: join(config.dataDir, 'index.json'),
  };
}

// Returns { index, store, close, scheduleSave } — `store` is null for SQLite,
// which has no separate persistence object to flush.
export async function openIndex(config, { log = () => {} } = {}) {
  const paths = indexPaths(config);

  if (config.storage === 'sqlite') {
    const index = new SqliteIndex(paths.sqlite);
    if (index.docCount === 0 && existsSync(paths.json) && statSync(paths.json).size > 200) {
      log(`found a JSON index at ${paths.json} that this SQLite index does not have.`);
      log('bring it across with:  npm run migrate:sqlite');
    }
    return {
      index,
      store: null,
      scheduleSave: () => {},
      close: async () => index.close(),
    };
  }

  const store = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
  const index = new SearchIndex(store);
  return {
    index,
    store,
    scheduleSave: () => store.scheduleSave(),
    close: async () => { index.compact(); await store.close(); },
  };
}
