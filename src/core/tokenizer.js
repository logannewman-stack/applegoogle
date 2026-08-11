// Text normalization and tokenization.
//
// The same pipeline runs over documents at index time and over queries at
// search time, so the stemmer only needs to be *consistent*, not perfect:
// "running" and "run" must land on the same stem, whatever it looks like.

const DIACRITICS_RE = /[\u0300-\u036f]/g;
const WORD_RE = /[\p{L}\p{N}]+/gu;

// Dropped from query *coverage* requirements only — stopwords are still
// indexed and scored (their IDF is naturally tiny), so exact phrases work.
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'will',
  'with', 'you', 'your',
]);

export function normalize(text) {
  return String(text).normalize('NFKD').replace(DIACRITICS_RE, '').toLowerCase();
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// Light suffix stripper (Porter-inspired, intentionally conservative).
export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;

  // Plurals
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (!w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.endsWith('s')) w = w.slice(0, -1);

  // Verb forms / adverbs
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);

  // Trailing e, so "code" and "coding" agree
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);

  // Undouble trailing consonants, so "running" -> "runn" -> "run"
  const last = w[w.length - 1];
  if (w.length > 3 && last === w[w.length - 2] && !VOWELS.has(last)) w = w.slice(0, -1);

  return w;
}

// Returns stemmed tokens. With {surfaces: true}, returns [{token, surface}]
// pairs so the index can remember a human-readable form of each stem.
export function tokenize(text, { surfaces = false } = {}) {
  const words = normalize(text).match(WORD_RE) || [];
  if (!surfaces) return words.map(stem);
  return words.map((w) => ({ token: stem(w), surface: w }));
}

// contentTerms receives stemmed tokens, so compare against stemmed stopwords.
const STEMMED_STOPWORDS = new Set([...STOPWORDS].map(stem));

// Query terms relevant for match-coverage requirements (stopwords excluded).
export function contentTerms(tokens) {
  const content = tokens.filter((t) => !STEMMED_STOPWORDS.has(t));
  return content.length > 0 ? content : tokens;
}
