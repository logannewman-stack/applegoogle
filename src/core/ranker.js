// Ranking. This file is the whole ballgame for trust, so the rules are stated
// plainly:
//
//   Every input to a document's score is an *earned* relevance signal —
//   how well the text matches, how many other pages link to it, how fresh
//   it is. There is no advertising system, no "sponsored" flag, no paid
//   boost, and no code path through which money can change a ranking.
//   test/ranker.test.js pins this: injecting sponsorship-style fields onto
//   documents must not move a single score.
//
// And because trust needs receipts, every result carries a `why` object:
// a plain-language explanation of exactly which signals put it on the page.
// The full signal list is public API (GET /v1/ranking).

import { tokenize, contentTerms } from './tokenizer.js';

// Published transparency manifest — served verbatim by GET /v1/ranking.
export const RANKING_SIGNALS = [
  {
    id: 'text_relevance',
    name: 'Text relevance (BM25F)',
    description:
      'How well the page text matches the query, using the BM25 formula with field weighting: matches in the title count 3x, in the description 1.5x, in the body 1x. Rare words count more than common ones.',
  },
  {
    id: 'phrase_proximity',
    name: 'Phrase proximity',
    description:
      'Pages where the query words appear next to each other, in order, rank higher than pages where they are scattered.',
  },
  {
    id: 'link_authority',
    name: 'Link authority (PageRank)',
    description:
      'Pages that other indexed pages choose to link to earn authority. This signal can only be earned from other sites — it cannot be bought.',
  },
  {
    id: 'freshness',
    name: 'Freshness',
    description: 'A small boost for recently crawled or updated pages.',
  },
];

export const EXCLUDED_FOREVER = [
  'Payment of any kind — there are no sponsored results and no paid placement.',
  'Advertising relationships — the engine runs no ads, so none exist to favor.',
  'Commercial partnerships with the sites being ranked.',
  'Political viewpoint of the page or its publisher.',
];

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const WEIGHTS = {
  authority: 0.35, //  score *= 1 + 0.35 * authority(0..1)
  phrase: 0.2, //      score *= 1 + 0.20 * fractionOfQueryBigramsAdjacent
  freshness: 0.05, //  score *= 1 + 0.05 * exp(-ageInDays / 365)
};

function idf(totalDocs, df) {
  return Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
}

// Which adjacent query-term pairs appear adjacent in the document?
// Returns { score: fractionMatched, firstPair: indexOfFirstMatchedPair|null }.
function phraseAnalysis(queryTokens, postingsByTerm, docId) {
  if (queryTokens.length < 2) return { score: 0, firstPair: null };
  let pairs = 0;
  let hits = 0;
  let firstPair = null;
  for (let i = 0; i < queryTokens.length - 1; i++) {
    const a = postingsByTerm.get(queryTokens[i])?.docs[docId];
    const b = postingsByTerm.get(queryTokens[i + 1])?.docs[docId];
    pairs++;
    if (!a || !b) continue;
    const set = new Set(b.pos);
    if (a.pos.some((p) => set.has(p + 1))) {
      hits++;
      if (firstPair === null) firstPair = i;
    }
  }
  return { score: pairs > 0 ? hits / pairs : 0, firstPair };
}

function freshnessFactor(fetchedAt, now) {
  if (!fetchedAt) return 1;
  const ageDays = Math.max(0, (now - new Date(fetchedAt).getTime()) / 86400000);
  return 1 + WEIGHTS.freshness * Math.exp(-ageDays / 365);
}

// Core scoring: returns { queryTokens, scored, details } where scored is
// [{id, score, matched}] best-first and details holds per-doc signal data
// used to build explanations.
export function scoreDocuments(index, query, { now = Date.now() } = {}) {
  const data = index.data;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { queryTokens, scored: [], details: new Map() };

  const uniqueTerms = [...new Set(queryTokens)];
  const required = contentTerms(uniqueTerms);
  const totalDocs = index.docCount;
  const avgLen = index.avgDocLength();

  // Document frequency and IDF once per term — not once per candidate.
  const postingsByTerm = new Map();
  const idfByTerm = new Map();
  for (const term of uniqueTerms) {
    const posting = data.postings[term];
    if (!posting) continue;
    postingsByTerm.set(term, posting);
    idfByTerm.set(term, idf(totalDocs, index.documentFrequency(term)));
  }

  // Gather candidates with per-doc matched term sets.
  const candidates = new Map(); // docId -> Set(term)
  for (const [term, posting] of postingsByTerm) {
    for (const docId in posting.docs) {
      const doc = data.docs[docId];
      if (!doc || doc.removed) continue;
      let set = candidates.get(docId);
      if (!set) {
        set = new Set();
        candidates.set(docId, set);
      }
      set.add(term);
    }
  }

  // Soft AND: prefer docs matching >= 60% of the meaningful query terms;
  // relax to any-match only when strictness leaves too few results.
  const minMatches = Math.max(1, Math.ceil(required.length * 0.6));
  const requiredSet = new Set(required);
  let pool = [...candidates].filter(([, terms]) => {
    let n = 0;
    for (const t of terms) if (requiredSet.has(t)) n++;
    return n >= minMatches;
  });
  if (pool.length < 5) pool = [...candidates];

  const scored = [];
  const details = new Map();
  for (const [docId, matchedTerms] of pool) {
    const doc = data.docs[docId];
    let bm25 = 0;
    const fieldHits = { title: new Set(), description: new Set() };
    for (const term of matchedTerms) {
      const entry = postingsByTerm.get(term).docs[docId];
      const norm = entry.w / (entry.w + BM25_K1 * (1 - BM25_B + (BM25_B * doc.len) / avgLen));
      bm25 += idfByTerm.get(term) * norm;
      if (entry.f?.[0] > 0) fieldHits.title.add(term);
      if (entry.f?.[1] > 0) fieldHits.description.add(term);
    }

    const phrase = phraseAnalysis(queryTokens, postingsByTerm, docId);
    const authorityFactor = 1 + WEIGHTS.authority * (doc.authority || 0);
    const proximityFactor = 1 + WEIGHTS.phrase * phrase.score;
    const freshFactor = freshnessFactor(doc.fetchedAt, now);
    const score = bm25 * authorityFactor * proximityFactor * freshFactor;

    scored.push({ id: docId, score, matched: [...matchedTerms] });
    details.set(docId, {
      bm25,
      authorityFactor,
      proximityFactor,
      freshFactor,
      firstPair: phrase.firstPair,
      fieldHits,
      requiredMatched: [...matchedTerms].filter((t) => requiredSet.has(t)),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { queryTokens, scored, details, required };
}

const listJoin = (items) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

function ageWords(fetchedAt, now) {
  if (!fetchedAt) return null;
  const days = (now - new Date(fetchedAt).getTime()) / 86400000;
  if (days < 1) return 'crawled today';
  if (days < 2) return 'crawled yesterday';
  if (days < 60) return `crawled ${Math.round(days)} days ago`;
  return `crawled ${Math.round(days / 30)} months ago`;
}

// The receipt: a plain-language account of why this result is on the page.
function buildWhy(doc, detail, queryInfo, now) {
  const { surfaceByStem, orderedSurfaces, required } = queryInfo;
  const quote = (stem) => `“${surfaceByStem.get(stem) || stem}”`;

  const matchedRequired = [...new Set(detail.requiredMatched)];
  const missing = required.filter((t) => !matchedRequired.includes(t));
  const parts = [];

  if (missing.length === 0) {
    parts.push(
      required.length === 1
        ? `matches your search term ${quote(required[0])}`
        : `matches all ${required.length} of your search terms`,
    );
  } else {
    parts.push(
      `matches ${matchedRequired.length} of your ${required.length} search terms (no match for ${listJoin(missing.map(quote))})`,
    );
  }

  const inTitle = [...detail.fieldHits.title].filter((t) => matchedRequired.includes(t));
  const inDescription = [...detail.fieldHits.description].filter(
    (t) => matchedRequired.includes(t) && !inTitle.includes(t),
  );
  if (inTitle.length > 0) {
    parts.push(`${listJoin(inTitle.slice(0, 3).map(quote))} appear${inTitle.length === 1 ? 's' : ''} in the title`);
  } else if (inDescription.length > 0) {
    parts.push(`${listJoin(inDescription.slice(0, 3).map(quote))} appear${inDescription.length === 1 ? 's' : ''} in the description`);
  }

  let phraseText = null;
  if (detail.firstPair !== null) {
    phraseText = `${orderedSurfaces[detail.firstPair]} ${orderedSurfaces[detail.firstPair + 1]}`;
    parts.push(`contains the exact phrase “${phraseText}”`);
  }

  const inlinks = doc.inlinks || 0;
  if (inlinks > 0) {
    parts.push(`${inlinks} other indexed page${inlinks === 1 ? ' links' : 's link'} here`);
  }

  const age = ageWords(doc.fetchedAt, now);
  if (age) parts.push(age);

  const summary = parts.join('; ') + '.';
  return {
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    matched: {
      terms: matchedRequired.map((t) => surfaceByStem.get(t) || t),
      of: required.length,
      missing: missing.map((t) => surfaceByStem.get(t) || t),
      inTitle: inTitle.map((t) => surfaceByStem.get(t) || t),
      inDescription: inDescription.map((t) => surfaceByStem.get(t) || t),
    },
    exactPhrase: phraseText,
    inboundLinks: inlinks,
    factors: {
      textRelevance: Number(detail.bm25.toFixed(3)),
      linkAuthority: Number(detail.authorityFactor.toFixed(3)),
      phraseProximity: Number(detail.proximityFactor.toFixed(3)),
      freshness: Number(detail.freshFactor.toFixed(3)),
    },
  };
}

// Build a text snippet centered on the densest cluster of query matches.
export function makeSnippet(text, queryTokens, maxLen = 220) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;

  const lower = clean.toLowerCase();
  const positions = [];
  for (const token of new Set(queryTokens)) {
    if (token.length < 2) continue;
    let i = 0;
    while (positions.length < 200 && (i = lower.indexOf(token, i)) !== -1) {
      positions.push(i);
      i += token.length;
    }
  }

  if (positions.length === 0) return `${clean.slice(0, maxLen - 1).trimEnd()}…`;

  positions.sort((a, b) => a - b);
  let best = positions[0];
  let bestCount = 0;
  for (const p of positions) {
    const count = positions.filter((q) => q >= p && q < p + maxLen).length;
    if (count > bestCount) {
      bestCount = count;
      best = p;
    }
  }

  let start = Math.max(0, best - 40);
  // Snap to a word boundary.
  if (start > 0) {
    const space = clean.indexOf(' ', start);
    if (space !== -1 && space < start + 30) start = space + 1;
  }
  const end = Math.min(clean.length, start + maxLen);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trimEnd()}${end < clean.length ? '…' : ''}`;
}

// Full search pipeline: score, diversify, paginate, snippet, explain.
export function search(index, query, { page = 1, perPage = 10, now = Date.now() } = {}) {
  const started = performance.now();
  const { queryTokens, scored, details, required = [] } = scoreDocuments(index, query, { now });

  // Query surfaces for human-readable explanations.
  const pairs = tokenize(query, { surfaces: true });
  const surfaceByStem = new Map();
  for (const { token, surface } of pairs) {
    if (!surfaceByStem.has(token)) surfaceByStem.set(token, surface);
  }
  const queryInfo = { surfaceByStem, orderedSurfaces: pairs.map((p) => p.surface), required };

  // Domain diversity: one site should not own a whole results page.
  const perDomain = new Map();
  const diversified = [];
  const overflow = [];
  for (const hit of scored) {
    const domain = index.data.docs[hit.id].domain;
    const seen = perDomain.get(domain) || 0;
    if (seen < 3) {
      diversified.push(hit);
      perDomain.set(domain, seen + 1);
    } else {
      overflow.push(hit);
    }
  }
  diversified.push(...overflow);

  const total = diversified.length;
  const startIdx = (page - 1) * perPage;
  const pageHits = diversified.slice(startIdx, startIdx + perPage);

  const results = pageHits.map((hit) => {
    const doc = index.data.docs[hit.id];
    return {
      url: doc.url,
      domain: doc.domain,
      title: doc.title || doc.url,
      snippet: doc.description && doc.description.length > 40
        ? makeSnippet(doc.description + ' — ' + doc.text, queryTokens)
        : makeSnippet(doc.text || doc.description, queryTokens),
      score: Number(hit.score.toFixed(4)),
      matchedTerms: hit.matched,
      why: buildWhy(doc, details.get(hit.id), queryInfo, now),
    };
  });

  return {
    query,
    normalizedTerms: queryTokens,
    total,
    page,
    perPage,
    tookMs: Number((performance.now() - started).toFixed(2)),
    results,
  };
}
