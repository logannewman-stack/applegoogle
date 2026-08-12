// The same inverted index, kept on disk instead of in memory.
//
// The JSON store loads every posting for every document at boot, so the
// ceiling is RAM, not disk: at ~5 KB of JSON per document it stops being
// reasonable somewhere around thirty thousand pages. That is a fine prototype
// and a poor search engine.
//
// Here the postings stay on disk and only the terms someone actually asked
// about are read. A query touches a few thousand rows whether the index holds
// ten thousand documents or ten million, which is the whole point.
//
// It implements exactly the read interface SearchIndex publishes, so the
// ranker cannot tell the two apart — test/index-parity.test.js runs the same
// assertions against both.
//
// Storage is node:sqlite, which ships inside Node 22. Northstar still has zero
// dependencies.

// Must precede the node:sqlite import — see the file for why.
import './quiet-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { tokenize } from './tokenizer.js';
import { normalizeUrl, FIELD_WEIGHTS } from './index.js';

const MAX_POSITIONS_PER_TERM = 24;
const MAX_LINKS_PER_DOC = 200;
const MAX_STORED_TEXT = 6000;
const FIELD_SLOT = { title: 0, description: 1, body: 2 };

// How many documents one term may contribute to a query.
//
// A word in a large share of the corpus carries almost no information — that
// is exactly what IDF says about it — but reading a million of its rows costs
// real time on every search. Rows come back ordered by field-weighted
// frequency, so the cap drops the weakest evidence for a term and never the
// strongest: a page where the word appears once in the footer, not the page
// titled after it.
//
// This is the one place where Northstar trades completeness for speed, so it
// is not allowed to be silent. Measurement settled where the line goes: a cap
// of 5,000 changed which pages reached the top ten, on an ordinary corpus as
// well as a pathological one. A truncated posting list is a different search,
// and a different search that says nothing is exactly the kind of quiet
// dishonesty this engine exists to refuse.
//
// So the default is set high enough that it does not bind on any index this
// engine will realistically hold, and when it does bind the search says so —
// postingsFor reports it, and the answer carries it through to the person who
// asked. The cap applies to earned frequency alone; nothing can buy its way
// past it.
const DEFAULT_MAX_POSTINGS_PER_TERM = 50000;

// Spelling correction against every term an index has ever seen gets worse,
// not better: correcting to a word that appears in one document is usually
// wrong. The common vocabulary is both faster and more accurate.
const VOCABULARY_LIMIT = 50000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  domain      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  len         INTEGER NOT NULL DEFAULT 0,
  lang        TEXT,
  fetched_at  TEXT,
  authority   REAL NOT NULL DEFAULT 0,
  inlinks     INTEGER NOT NULL DEFAULT 0,
  links       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS docs_domain ON docs(domain);

-- Clustered by term: the rows for one query term sit together on disk, which
-- is the single access pattern that matters.
CREATE TABLE IF NOT EXISTS postings (
  term   TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  w      REAL NOT NULL,
  f0     INTEGER NOT NULL DEFAULT 0,
  f1     INTEGER NOT NULL DEFAULT 0,
  f2     INTEGER NOT NULL DEFAULT 0,
  pos    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (term, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS postings_doc ON postings(doc_id);

CREATE TABLE IF NOT EXISTS terms (
  term    TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  df      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS terms_df ON terms(df DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export class SqliteIndex {
  constructor(path, { readonly = false, maxPostingsPerTerm = DEFAULT_MAX_POSTINGS_PER_TERM } = {}) {
    this.maxPostingsPerTerm = maxPostingsPerTerm;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path, { readOnly: readonly });
    if (!readonly) {
      // WAL lets a search read while a crawl writes. NORMAL trades a
      // fsync-per-commit for the OS's word that the data is written — the
      // right trade for an index that can always be re-crawled.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(SCHEMA);
    }
    this.db.exec('PRAGMA temp_store = MEMORY');

    this._prepare();
    this._inTransaction = false;
    this._writesSinceCommit = 0;
    this._stats = null;
    this._docCache = new Map(); // small LRU; one search asks for a doc repeatedly
    this._vocabCache = null;
  }

  _prepare() {
    const db = this.db;
    this.q = {
      insertDoc: db.prepare(`INSERT INTO docs (url, domain, title, description, text, len, lang, fetched_at, links)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      docById: db.prepare('SELECT * FROM docs WHERE id = ?'),
      // Scoring needs four scalars per document and never the text. Reading
      // the wide columns for every candidate costs more than the ranking.
      docStatsMany: db.prepare(`SELECT id, len, authority, inlinks, fetched_at, domain FROM docs
                                WHERE id IN (SELECT value FROM json_each(?))`),
      idByUrl: db.prepare('SELECT id FROM docs WHERE url = ?'),
      deleteDoc: db.prepare('DELETE FROM docs WHERE id = ?'),
      deleteDocPostings: db.prepare('SELECT term FROM postings WHERE doc_id = ?'),
      deletePostingsFor: db.prepare('DELETE FROM postings WHERE doc_id = ?'),
      insertPosting: db.prepare(`INSERT OR REPLACE INTO postings (term, doc_id, w, f0, f1, f2, pos)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`),
      postingsForTerm: db.prepare(`SELECT doc_id, w, f0, f1, f2, pos FROM postings
                                   WHERE term = ? ORDER BY w DESC LIMIT ?`),
      upsertTerm: db.prepare(`INSERT INTO terms (term, display, df) VALUES (?, ?, 1)
                              ON CONFLICT(term) DO UPDATE SET df = df + 1`),
      decrementTerm: db.prepare('UPDATE terms SET df = df - 1 WHERE term = ?'),
      pruneTerms: db.prepare('DELETE FROM terms WHERE df <= 0'),
      termRow: db.prepare('SELECT display, df FROM terms WHERE term = ?'),
      termCount: db.prepare('SELECT COUNT(*) AS n FROM terms WHERE df > 0'),
      vocabulary: db.prepare('SELECT term FROM terms WHERE df > 0 ORDER BY df DESC LIMIT ?'),
      commonTerms: db.prepare('SELECT term, display, df FROM terms WHERE df > 0 ORDER BY df DESC LIMIT ?'),
      stats: db.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(len), 0) AS total_len FROM docs'),
      sampleDoc: db.prepare('SELECT * FROM docs LIMIT 1'),
      allDocLinks: db.prepare('SELECT id, url, links FROM docs'),
      setAuthority: db.prepare('UPDATE docs SET authority = ?, inlinks = ? WHERE id = ?'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────
  //
  // A commit costs a disk sync, so a crawl that committed per page would spend
  // its life waiting. Writes accumulate in one transaction and land in
  // batches; save() and close() flush whatever is outstanding.

  _begin() {
    if (!this._inTransaction) {
      this.db.exec('BEGIN');
      this._inTransaction = true;
    }
  }

  _afterWrite() {
    this._stats = null;
    this._vocabCache = null;
    if (++this._writesSinceCommit >= 500) this.commit();
  }

  commit() {
    if (this._inTransaction) {
      this.db.exec('COMMIT');
      this._inTransaction = false;
    }
    this._writesSinceCommit = 0;
  }

  addDocument(doc) {
    const url = normalizeUrl(doc.url);
    if (!url) throw new Error(`Invalid document URL: ${doc.url}`);

    this._begin();

    // Re-adding a URL replaces it outright. A row can simply be deleted here,
    // so unlike the JSON store there are no tombstones to sweep up later.
    const existing = this.q.idByUrl.get(url);
    if (existing) this.removeDocument(existing.id);

    const fields = {
      title: tokenize(doc.title || '', { surfaces: true }),
      description: tokenize(doc.description || '', { surfaces: true }),
      body: tokenize(doc.text || '', { surfaces: true }),
    };

    let pos = 0;
    let len = 0;
    const perTerm = new Map();
    for (const [field, tokens] of Object.entries(fields)) {
      const weight = FIELD_WEIGHTS[field];
      const slot = FIELD_SLOT[field];
      for (const { token, surface } of tokens) {
        let t = perTerm.get(token);
        if (!t) {
          t = { w: 0, pos: [], f: [0, 0, 0], display: surface };
          perTerm.set(token, t);
        }
        t.w += weight;
        t.f[slot]++;
        if (t.pos.length < MAX_POSITIONS_PER_TERM) t.pos.push(pos);
        pos++;
        len++;
      }
    }

    const links = [];
    for (const raw of doc.links || []) {
      const norm = normalizeUrl(raw, url);
      if (norm && norm !== url && !links.includes(norm)) {
        links.push(norm);
        if (links.length >= MAX_LINKS_PER_DOC) break;
      }
    }

    const info = this.q.insertDoc.run(
      url,
      new URL(url).hostname,
      (doc.title || '').trim().slice(0, 300),
      (doc.description || '').trim().slice(0, 500),
      (doc.text || '').slice(0, MAX_STORED_TEXT),
      len,
      doc.lang || null,
      doc.fetchedAt || null,
      JSON.stringify(links),
    );
    const id = Number(info.lastInsertRowid);

    for (const [term, t] of perTerm) {
      this.q.insertPosting.run(term, id, t.w, t.f[0], t.f[1], t.f[2], JSON.stringify(t.pos));
      this.q.upsertTerm.run(term, t.display);
    }

    this._touch();
    this._afterWrite();
    return String(id);
  }

  removeDocument(id) {
    const docId = Number(id);
    const doc = this.q.docById.get(docId);
    if (!doc) return;
    this._begin();
    // Document frequency is maintained as a column rather than counted, so
    // every term this document contributed has to give its count back.
    for (const row of this.q.deleteDocPostings.all(docId)) {
      this.q.decrementTerm.run(row.term);
    }
    this.q.deletePostingsFor.run(docId);
    this.q.deleteDoc.run(docId);
    this.q.pruneTerms.run();
    this._docCache.delete(String(docId));
    this._touch();
    this._afterWrite();
  }

  _touch() {
    this.q.setMeta.run('updatedAt', new Date().toISOString());
  }

  // ── Reads: the interface the ranker actually uses ──────────────────────

  _computeStats() {
    if (!this._stats) {
      const row = this.q.stats.get();
      this._stats = { docs: row.docs, totalLen: row.total_len };
    }
    return this._stats;
  }

  get docCount() {
    return this._computeStats().docs;
  }

  get termCount() {
    return this.q.termCount.get().n;
  }

  avgDocLength() {
    const { docs, totalLen } = this._computeStats();
    return docs > 0 ? totalLen / docs : 1;
  }

  get updatedAt() {
    return this.q.getMeta.get('updatedAt')?.value || null;
  }

  // Only live documents appear here — a deleted row simply is not returned —
  // so callers never have to filter tombstones the way the JSON store needs.
  postingsFor(term) {
    const rows = this.q.postingsForTerm.all(term, this.maxPostingsPerTerm);
    if (rows.length === 0) return null;
    const docs = Object.create(null);
    for (const r of rows) docs[String(r.doc_id)] = posting(r);
    const row = this.q.termRow.get(term);
    return {
      display: row?.display || term,
      docs,
      // True when this word appears on more pages than one search may weigh.
      // The caller is expected to pass it on rather than swallow it.
      truncated: rows.length >= this.maxPostingsPerTerm,
      documentFrequency: row?.df ?? rows.length,
    };
  }

  doc(docId) {
    const key = String(docId);
    const cached = this._docCache.get(key);
    if (cached !== undefined) return cached;
    const row = this.q.docById.get(Number(docId));
    const doc = row ? hydrate(row) : undefined;
    if (this._docCache.size > 4000) this._docCache.clear();
    this._docCache.set(key, doc);
    return doc;
  }

  // Map(docId -> { len, authority, inlinks, fetchedAt, domain }) in one query.
  // This is the hot path: a common query term names tens of thousands of
  // documents, and asking for them one at a time — or asking for their full
  // text — dominates everything else the ranker does.
  docStatsMany(docIds) {
    const stats = new Map();
    if (docIds.length === 0) return stats;
    for (const row of this.q.docStatsMany.all(JSON.stringify(docIds.map(Number)))) {
      stats.set(String(row.id), {
        len: row.len,
        authority: row.authority,
        inlinks: row.inlinks,
        fetchedAt: row.fetched_at,
        domain: row.domain,
      });
    }
    return stats;
  }

  docIdForUrl(url) {
    const row = this.q.idByUrl.get(url);
    return row ? String(row.id) : undefined;
  }

  hasUrl(url) {
    return this.q.idByUrl.get(url) !== undefined;
  }

  documentFrequency(term) {
    return this.q.termRow.get(term)?.df || 0;
  }

  vocabulary() {
    if (!this._vocabCache) {
      this._vocabCache = this.q.vocabulary.all(VOCABULARY_LIMIT).map((r) => r.term);
    }
    return this._vocabCache;
  }

  displayFor(term) {
    return this.q.termRow.get(term)?.display || term;
  }

  termsWithFrequency() {
    return this.q.commonTerms.all(5000);
  }

  sampleDocument() {
    const row = this.q.sampleDoc.get();
    return row ? hydrate(row) : null;
  }

  // ── Batch operations ───────────────────────────────────────────────────

  // PageRank over the crawled link graph, same as the JSON backend. The URL
  // map is held in memory for the run — tens of bytes per document, which is
  // affordable for an offline pass in a way that the postings are not.
  computeAuthority({ damping = 0.85, iterations = 20 } = {}) {
    this.commit();
    const rows = this.q.allDocLinks.all();
    const n = rows.length;
    if (n === 0) return;

    const idByUrl = new Map(rows.map((r) => [r.url, r.id]));
    const outEdges = new Map();
    const inlinkCounts = new Map();
    for (const row of rows) {
      const targets = [];
      for (const link of JSON.parse(row.links)) {
        const target = idByUrl.get(link);
        if (target !== undefined && target !== row.id) {
          targets.push(target);
          inlinkCounts.set(target, (inlinkCounts.get(target) || 0) + 1);
        }
      }
      outEdges.set(row.id, targets);
    }

    const ids = rows.map((r) => r.id);
    let rank = new Map(ids.map((id) => [id, 1 / n]));
    for (let i = 0; i < iterations; i++) {
      const next = new Map(ids.map((id) => [id, (1 - damping) / n]));
      let danglingMass = 0;
      for (const id of ids) {
        const targets = outEdges.get(id);
        const r = rank.get(id);
        if (targets.length === 0) {
          danglingMass += r;
        } else {
          const share = (damping * r) / targets.length;
          for (const t of targets) next.set(t, next.get(t) + share);
        }
      }
      const danglingShare = (damping * danglingMass) / n;
      for (const id of ids) next.set(id, next.get(id) + danglingShare);
      rank = next;
    }

    const max = Math.max(...rank.values());
    this._begin();
    for (const id of ids) {
      this.q.setAuthority.run(max > 0 ? rank.get(id) / max : 0, inlinkCounts.get(id) || 0, id);
    }
    this.commit();
    this._docCache.clear();
  }

  // Nothing to sweep: rows are deleted rather than tombstoned. Kept so the two
  // backends answer the same calls.
  compact() {}

  async save() {
    this.commit();
  }

  close() {
    this.commit();
    this.db.close();
  }
}

// ── Turning rows into what the ranker expects, as late as possible ────────
//
// A common query term names tens of thousands of documents, but only the few
// hundred that survive the match floor are ever scored, and only those are
// asked for positions. Parsing every row's JSON up front costs more than the
// entire ranking pass. So the expensive fields are getters that parse once, on
// first touch, and cache the result on the object.

function lazyJson(target, key, raw) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      const value = JSON.parse(raw);
      Object.defineProperty(this, key, { value, enumerable: true, configurable: true });
      return value;
    },
  });
}

// { w, f: [title, description, body], pos: [...] }
//
// Built eagerly and plainly. Deferring these behind getters was measured and
// was *slower*: every pooled document reads both fields anyway, so laziness
// bought nothing and the property machinery cost real time.
function posting(row) {
  return { w: row.w, f: [row.f0, row.f1, row.f2], pos: JSON.parse(row.pos) };
}

// SQL columns back into the shape the ranker expects.
function hydrate(row) {
  const doc = {
    url: row.url,
    domain: row.domain,
    title: row.title,
    description: row.description,
    text: row.text,
    len: row.len,
    lang: row.lang,
    fetchedAt: row.fetched_at,
    authority: row.authority,
    inlinks: row.inlinks,
  };
  lazyJson(doc, 'links', row.links);
  return doc;
}
