// The inverted index: documents in, postings out.
//
// Layout (all plain JSON so it can persist through JsonStore):
//   docs:      docId -> { url, domain, title, description, text, len, fetchedAt,
//                         links, authority, removed }
//   postings:  term  -> { display, docs: { docId: { w, pos } } }
//     w   = field-weighted term frequency (title counts 3x, description 1.5x, body 1x)
//     pos = token positions in the combined title+description+body stream,
//           capped, used for phrase proximity scoring
//
// Re-adding a URL tombstones the old document (postings entries for removed
// docs are skipped at search time and dropped on the next full save/compact).

import { tokenize } from './tokenizer.js';

export const FIELD_WEIGHTS = { title: 3, description: 1.5, body: 1 };
const MAX_POSITIONS_PER_TERM = 24;
const MAX_LINKS_PER_DOC = 200;
const MAX_STORED_TEXT = 6000;

export function emptyIndexData() {
  return { version: 1, docs: {}, postings: {}, urlToDoc: {}, nextId: 1, updatedAt: null };
}

export function normalizeUrl(raw, base) {
  let u;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // Tracking params carry zero relevance signal; stripping them dedupes URLs.
  const params = [...u.searchParams.keys()];
  for (const p of params) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)/i.test(p)) u.searchParams.delete(p);
  }
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
  return s;
}

export class SearchIndex {
  constructor(store) {
    this.store = store; // JsonStore whose .data matches emptyIndexData()
  }

  get data() {
    return this.store.data;
  }

  get docCount() {
    let n = 0;
    for (const id in this.data.docs) if (!this.data.docs[id].removed) n++;
    return n;
  }

  get termCount() {
    return Object.keys(this.data.postings).length;
  }

  avgDocLength() {
    let total = 0;
    let n = 0;
    for (const id in this.data.docs) {
      const d = this.data.docs[id];
      if (!d.removed) {
        total += d.len;
        n++;
      }
    }
    return n > 0 ? total / n : 1;
  }

  // doc: { url, title, description, text, links[], lang, fetchedAt }
  addDocument(doc) {
    const url = normalizeUrl(doc.url);
    if (!url) throw new Error(`Invalid document URL: ${doc.url}`);

    const existing = this.data.urlToDoc[url];
    if (existing !== undefined) this.removeDocument(existing);

    const id = String(this.data.nextId++);
    const fields = {
      title: tokenize(doc.title || '', { surfaces: true }),
      description: tokenize(doc.description || '', { surfaces: true }),
      body: tokenize(doc.text || '', { surfaces: true }),
    };

    // One combined position stream: title, then description, then body.
    let pos = 0;
    let len = 0;
    const perTerm = new Map(); // term -> { w, pos: [], display }
    for (const [field, tokens] of Object.entries(fields)) {
      const weight = FIELD_WEIGHTS[field];
      for (const { token, surface } of tokens) {
        let t = perTerm.get(token);
        if (!t) {
          t = { w: 0, pos: [], display: surface };
          perTerm.set(token, t);
        }
        t.w += weight;
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

    this.data.docs[id] = {
      url,
      domain: new URL(url).hostname,
      title: (doc.title || '').trim().slice(0, 300),
      description: (doc.description || '').trim().slice(0, 500),
      text: (doc.text || '').slice(0, MAX_STORED_TEXT),
      len,
      lang: doc.lang || null,
      fetchedAt: doc.fetchedAt || null,
      links,
      authority: 0,
    };
    this.data.urlToDoc[url] = id;

    for (const [term, t] of perTerm) {
      let posting = this.data.postings[term];
      if (!posting) {
        posting = { display: t.display, docs: {} };
        this.data.postings[term] = posting;
      }
      posting.docs[id] = { w: t.w, pos: t.pos };
    }

    this.data.updatedAt = new Date().toISOString();
    return id;
  }

  removeDocument(id) {
    const doc = this.data.docs[id];
    if (!doc || doc.removed) return;
    doc.removed = true;
    delete this.data.urlToDoc[doc.url];
  }

  // Drop tombstoned docs and their postings entries. Called before saves.
  compact() {
    const removed = new Set();
    for (const id in this.data.docs) {
      if (this.data.docs[id].removed) removed.add(id);
    }
    if (removed.size === 0) return;
    for (const term in this.data.postings) {
      const posting = this.data.postings[term];
      for (const id of removed) delete posting.docs[id];
      if (Object.keys(posting.docs).length === 0) delete this.data.postings[term];
    }
    for (const id of removed) delete this.data.docs[id];
  }

  documentFrequency(term) {
    const posting = this.data.postings[term];
    if (!posting) return 0;
    let df = 0;
    for (const id in posting.docs) if (!this.data.docs[id]?.removed) df++;
    return df;
  }

  // Link authority: PageRank over the crawled link graph. This is an *earned*
  // signal — it can only be influenced by other pages choosing to link to you.
  computeAuthority({ damping = 0.85, iterations = 20 } = {}) {
    const ids = Object.keys(this.data.docs).filter((id) => !this.data.docs[id].removed);
    const n = ids.length;
    if (n === 0) return;

    const outEdges = new Map();
    for (const id of ids) {
      const targets = [];
      for (const link of this.data.docs[id].links) {
        const target = this.data.urlToDoc[link];
        if (target !== undefined && target !== id) targets.push(target);
      }
      outEdges.set(id, targets);
    }

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
    for (const id of ids) {
      this.data.docs[id].authority = max > 0 ? rank.get(id) / max : 0;
    }
  }

  async save() {
    this.compact();
    await this.store.save();
  }
}
