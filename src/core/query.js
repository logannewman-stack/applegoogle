// Query language.
//
// Northstar understands four things beyond plain words:
//
//   "exact phrase"   these words, together, in this order
//   -word            pages containing this word are excluded
//   site:example.org only pages from this site (or a subdomain of it)
//   plain words      everything else — ranked, never required
//
// Operators only ever *narrow* or *require*; none of them can promote a page.
// Whatever survives is still ranked by the same earned signals, so the
// covenant in INTEGRITY.md holds no matter how a query is written.

import { tokenize } from './tokenizer.js';

const PHRASE_RE = /"([^"]+)"|“([^”]+)”/g;
const SITE_RE = /(?:^|\s)site:([a-z0-9.-]+\.[a-z]{2,})/gi;
const EXCLUDE_RE = /(?:^|\s)-([^\s"]+)/g;

export function parseQuery(raw) {
  let text = String(raw || '');
  const phrases = [];
  const excluded = [];
  let site = null;

  // Phrases first, so a quoted "site:x" or "-y" stays literal.
  text = text.replace(PHRASE_RE, (_, a, b) => {
    const surface = (a ?? b).trim();
    const tokens = tokenize(surface);
    if (tokens.length > 0) phrases.push({ surface, tokens });
    return ' ';
  });

  text = text.replace(SITE_RE, (_, host) => {
    site = host.toLowerCase();
    return ' ';
  });

  text = text.replace(EXCLUDE_RE, (match, word) => {
    const tokens = tokenize(word);
    if (tokens.length > 0) excluded.push({ surface: word, token: tokens[0] });
    return ' ';
  });

  const free = text.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();

  // Terms that drive relevance: free text plus everything inside phrases.
  const terms = [...tokenize(free)];
  for (const p of phrases) terms.push(...p.tokens);

  return {
    raw: String(raw || ''),
    free,
    terms,
    phrases,
    excluded,
    site,
    hasOperators: phrases.length > 0 || excluded.length > 0 || site !== null,
  };
}

// Does this document contain the tokens adjacently, in order?
// Positions are capped per term at index time, so very long documents can
// under-report; that only ever loses a match, never invents one.
export function hasPhrase(postingsByTerm, docId, tokens) {
  if (tokens.length === 0) return false;
  const first = postingsByTerm.get(tokens[0])?.docs[docId];
  if (!first) return false;
  if (tokens.length === 1) return true;

  const later = [];
  for (let i = 1; i < tokens.length; i++) {
    const entry = postingsByTerm.get(tokens[i])?.docs[docId];
    if (!entry) return false;
    later.push(new Set(entry.pos));
  }
  return first.pos.some((start) => later.every((set, i) => set.has(start + i + 1)));
}

// Bounded Levenshtein: bails out as soon as the distance exceeds `max`.
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Nearest indexed term to a term the index has never seen.
// Short words get a tighter budget so "cat" cannot become "car".
export function nearestTerm(index, term, { vocabulary } = {}) {
  const max = term.length <= 4 ? 1 : 2;
  const vocab = vocabulary || Object.keys(index.data.postings);
  let best = null;
  let bestScore = Infinity;
  let bestDf = 0;
  for (const candidate of vocab) {
    if (Math.abs(candidate.length - term.length) > max) continue;
    // Typos rarely land on the first letter, and a one-edit change there is
    // usually a different word entirely ("bat" is not a misspelt "cat").
    // Requiring the initial to match keeps corrections trustworthy.
    if (candidate[0] !== term[0]) continue;
    const d = editDistance(term, candidate, max);
    if (d > max) continue;
    const df = index.documentFrequency(candidate);
    if (df === 0) continue;
    if (d < bestScore || (d === bestScore && df > bestDf)) {
      best = candidate;
      bestScore = d;
      bestDf = df;
    }
  }
  return best;
}

// If some query terms are absent from the index but have close neighbours,
// return a corrected token list plus a human-readable rewrite of the query.
export function correctQuery(index, parsed) {
  const vocabulary = Object.keys(index.data.postings);
  if (vocabulary.length === 0) return null;

  const surfaces = tokenize(parsed.free, { surfaces: true });
  const replacements = new Map(); // stem -> corrected display word
  let changed = false;

  for (const { token, surface } of surfaces) {
    if (replacements.has(token)) continue;
    if (index.documentFrequency(token) > 0) continue;
    const near = nearestTerm(index, token, { vocabulary });
    if (!near) continue;
    replacements.set(token, index.data.postings[near].display || near);
    changed = true;
  }
  if (!changed) return null;

  // Rewrite only the free-text portion; operators are left exactly as typed.
  const rewrittenFree = parsed.free.split(/\s+/).map((word) => {
    const [stem] = tokenize(word);
    const fix = replacements.get(stem);
    return fix ? fix : word;
  }).join(' ');

  const rewritten = parsed.raw.replace(parsed.free, rewrittenFree).trim();
  if (rewritten.toLowerCase() === parsed.raw.trim().toLowerCase()) return null;
  return { query: rewritten, from: parsed.raw.trim() };
}
