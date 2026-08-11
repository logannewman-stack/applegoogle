// Tiny JSON-on-disk persistence with atomic writes.
//
// This is deliberately simple for v1: the whole store lives in memory and is
// flushed to disk as one JSON file (write-to-temp, then rename, so a crash
// mid-write can never corrupt existing data). Good for prototype scale
// (tens of thousands of documents). The README documents the upgrade path
// to SQLite/Postgres when the index outgrows this.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export class JsonStore {
  constructor(dataDir, name, initial) {
    this.path = join(dataDir, `${name}.json`);
    this.initial = initial;
    this.data = structuredClone(initial);
    this._saveTimer = null;
    this._saving = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = structuredClone(this.initial);
    }
    return this;
  }

  // Debounced save: mutate `store.data` freely, then call scheduleSave().
  scheduleSave(delayMs = 500) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save().catch((err) => console.error(`[store] save failed for ${this.path}:`, err));
    }, delayMs);
    this._saveTimer.unref?.();
  }

  async save() {
    // Serialize writes so overlapping saves can't interleave their tmp files.
    this._saving = this._saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data), 'utf8');
      await rename(tmp, this.path);
    });
    return this._saving;
  }

  async close() {
    clearTimeout(this._saveTimer);
    await this.save();
  }
}
