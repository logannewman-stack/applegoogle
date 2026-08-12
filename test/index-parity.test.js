// Two storage engines, one set of answers.
//
// The JSON store keeps every posting in memory; SQLite keeps them on disk and
// reads only the terms someone asked about. That difference must be invisible
// above the storage layer — if the two ever disagree about a ranking, the one
// that is wrong is whichever you are not looking at.
//
// So every assertion here runs twice, against both.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { SqliteIndex } from '../src/core/sqlite-index.js';
import { search, scoreDocuments } from '../src/core/ranker.js';

const DOCS = [
  {
    url: 'https://x.example/tides', title: 'How Tides Work',
    description: 'The moon, the sun, and a bulge of water.',
    text: 'Tidal range is the difference between high water and low water. The moon raises the tide.',
    links: ['https://x.example/moon'],
  },
  {
    url: 'https://x.example/moon', title: 'The Moon',
    description: 'Our nearest neighbour.',
    text: 'The moon orbits the Earth every twenty-seven days and its gravity raises the tides.',
    links: [],
  },
  {
    url: 'https://y.example/coffee', title: 'Pour-Over Coffee',
    description: 'Brewing at home.',
    text: 'Grind medium fine, bloom for thirty seconds, then pour in slow spirals.',
    links: ['https://x.example/tides'],
  },
  {
    url: 'https://y.example/espresso', title: 'Espresso Basics',
    description: 'Nine bars of pressure.',
    text: 'A short shot pulled under pressure. Grind finer than pour over coffee.',
    links: ['https://x.example/tides'],
  },
];

const BACKENDS = {
  json: () => {
    const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
    return { index, close() {} };
  },
  sqlite: () => {
    const index = new SqliteIndex(':memory:');
    return { index, close: () => index.close() };
  },
};

function build(make) {
  const { index, close } = make();
  for (const doc of DOCS) {
    index.addDocument({ ...doc, fetchedAt: '2026-08-01T00:00:00.000Z' });
  }
  index.computeAuthority();
  return { index, close };
}

for (const [name, make] of Object.entries(BACKENDS)) {
  describe(`${name} backend`, () => {
    test('counts documents, terms and average length', () => {
      const { index, close } = build(make);
      try {
        assert.equal(index.docCount, 4);
        assert.ok(index.termCount > 20);
        assert.ok(index.avgDocLength() > 5);
        assert.ok(index.updatedAt, 'records when it last changed');
      } finally { close(); }
    });

    test('resolves URLs to documents and back', () => {
      const { index, close } = build(make);
      try {
        const id = index.docIdForUrl('https://x.example/tides');
        assert.ok(id !== undefined);
        assert.equal(index.doc(id).title, 'How Tides Work');
        assert.equal(index.doc(id).domain, 'x.example');
        assert.equal(index.hasUrl('https://x.example/tides'), true);
        assert.equal(index.hasUrl('https://nope.example/'), false);
      } finally { close(); }
    });

    test('postings carry the weights, field hits and positions ranking needs', () => {
      const { index, close } = build(make);
      try {
        const posting = index.postingsFor('tidal');
        assert.ok(posting, 'a term the corpus contains is found');
        const entries = Object.values(posting.docs);
        assert.equal(entries.length, 1);
        assert.ok(entries[0].w > 0);
        assert.equal(entries[0].f.length, 3, 'title/description/body triple');
        assert.ok(Array.isArray(entries[0].pos));
        assert.equal(index.postingsFor('zzzznotaword'), null);
      } finally { close(); }
    });

    test('document frequency counts documents, not occurrences', () => {
      const { index, close } = build(make);
      try {
        // "moon" is in two documents, and more than once in one of them.
        assert.equal(index.documentFrequency('moon'), 2);
        assert.equal(index.documentFrequency('zzzznotaword'), 0);
      } finally { close(); }
    });

    test('re-adding a URL replaces the old document rather than duplicating it', () => {
      const { index, close } = build(make);
      try {
        assert.equal(index.docCount, 4);
        index.addDocument({
          url: 'https://x.example/tides', title: 'How Tides Work, Revised',
          description: '', text: 'Entirely new text about harbours.', links: [],
          fetchedAt: '2026-08-02T00:00:00.000Z',
        });
        assert.equal(index.docCount, 4, 'still four documents, not five');
        const id = index.docIdForUrl('https://x.example/tides');
        assert.equal(index.doc(id).title, 'How Tides Work, Revised');
        // The old text must no longer be findable through it.
        assert.equal(index.documentFrequency('tidal'), 0, 'the replaced text left the index');
        assert.equal(index.documentFrequency('harbour'), 1, 'and the new text entered it');
      } finally { close(); }
    });

    test('removing a document takes its postings with it', () => {
      const { index, close } = build(make);
      try {
        index.removeDocument(index.docIdForUrl('https://y.example/coffee'));
        assert.equal(index.docCount, 3);
        assert.equal(search(index, 'bloom').total, 0, 'its words stop matching');
        const posting = index.postingsFor('grind');
        // "grind" was in both coffee documents; one remains.
        assert.equal(Object.keys(posting.docs).length, 1);
      } finally { close(); }
    });

    test('link authority is earned from inbound links', () => {
      const { index, close } = build(make);
      try {
        const linked = index.doc(index.docIdForUrl('https://x.example/tides'));
        const lonely = index.doc(index.docIdForUrl('https://y.example/espresso'));
        assert.equal(linked.inlinks, 2, 'two pages chose to link here');
        assert.equal(lonely.inlinks, 0);
        assert.ok(linked.authority > lonely.authority);
      } finally { close(); }
    });

    test('ranks the same way, with the same reasoning', () => {
      const { index, close } = build(make);
      try {
        const { results, total } = search(index, 'tidal range');
        assert.equal(total, 1);
        assert.equal(results[0].url, 'https://x.example/tides');
        assert.ok(results[0].why.reasons.length > 0);
        assert.match(results[0].why.assurance, /cannot be bought/i);

        const coffee = search(index, 'pour over coffee');
        assert.equal(coffee.results[0].url, 'https://y.example/coffee');
      } finally { close(); }
    });

    test('a question the corpus cannot answer returns nothing', () => {
      const { index, close } = build(make);
      try {
        assert.equal(search(index, 'photosynthesis chlorophyll').total, 0);
      } finally { close(); }
    });

    test('operators narrow and never promote', () => {
      const { index, close } = build(make);
      try {
        assert.equal(search(index, 'site:y.example coffee').results.every((r) => r.domain === 'y.example'), true);
        assert.equal(search(index, 'coffee -espresso').results.some((r) => /espresso/.test(r.url)), false);
        const phrase = search(index, '"pour over"');
        assert.ok(phrase.total >= 1);
      } finally { close(); }
    });

    test('INTEGRITY: sponsorship-style fields cannot change any score', () => {
      const { index, close } = build(make);
      try {
        const before = scoreDocuments(index, 'pour over coffee', { now: 1754956800000 });
        // Whatever the storage engine, there must be no column, key or field
        // through which money reaches a ranking.
        for (const doc of DOCS) {
          const id = index.docIdForUrl(doc.url);
          Object.assign(index.doc(id), {
            sponsored: true, adBudget: 1e9, paidBoost: 9999, partnerTier: 'platinum',
          });
        }
        const after = scoreDocuments(index, 'pour over coffee', { now: 1754956800000 });
        assert.deepEqual(after.scored, before.scored);
      } finally { close(); }
    });
  });
}

describe('the two backends agree exactly', () => {
  test('identical corpora produce identical rankings and scores', () => {
    const json = build(BACKENDS.json);
    const sqlite = build(BACKENDS.sqlite);
    try {
      for (const query of ['tidal range', 'moon', 'pour over coffee', 'grind pressure', 'the moon and the tides']) {
        const a = search(json.index, query, { now: 1754956800000 });
        const b = search(sqlite.index, query, { now: 1754956800000 });
        assert.deepEqual(
          b.results.map((r) => [r.url, r.score.toFixed(6)]),
          a.results.map((r) => [r.url, r.score.toFixed(6)]),
          `"${query}" ranked differently between backends`,
        );
        assert.deepEqual(
          b.results.map((r) => r.why.reasons.map((x) => x.text)),
          a.results.map((r) => r.why.reasons.map((x) => x.text)),
          `"${query}" explained itself differently between backends`,
        );
      }
    } finally { json.close(); sqlite.close(); }
  });
});

describe('a search that could not weigh everything says so', () => {
  // The disk-backed index caps how many documents one word may contribute, so
  // a single very common word cannot make every search read the whole corpus.
  // Measurement showed that cap changing which pages reach the top ten — so
  // the rule is not "the cap is harmless", it is "the cap is never silent".
  const build = (cap) => {
    const index = new SqliteIndex(':memory:', { maxPostingsPerTerm: cap });
    for (let i = 0; i < 40; i++) {
      index.addDocument({
        url: `https://x.example/page-${i}`,
        title: i === 0 ? 'Tidal range explained' : `Notes ${i}`,
        description: '',
        text: `tidal observations recorded at station ${i}`,
        links: [],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      });
    }
    return index;
  };

  test('reports the word it could not read in full', () => {
    const index = build(10);
    try {
      const { limited } = search(index, 'tidal');
      assert.equal(limited.length, 1, 'the truncated word is named');
      assert.equal(limited[0].term, 'tidal');
      assert.equal(limited[0].appearsOn, 40, 'and how many pages actually carry it');
    } finally { index.close(); }
  });

  test('says nothing when it did read everything', () => {
    const index = build(10000);
    try {
      assert.deepEqual(search(index, 'tidal').limited, [], 'no cap hit, no claim made');
      // A word that is genuinely rare is never reported as truncated.
      assert.deepEqual(search(index, 'station').limited.map((l) => l.term), []);
    } finally { index.close(); }
  });

  test('the in-memory backend never truncates, and never claims to', () => {
    const index = new SearchIndex({ data: emptyIndexData(), save: async () => {} });
    for (const doc of DOCS) index.addDocument({ ...doc, fetchedAt: '2026-08-01T00:00:00.000Z' });
    assert.deepEqual(search(index, 'moon').limited, []);
    assert.equal(index.postingsFor('moon').truncated, false);
  });

  test('truncation keeps the strongest evidence, not the first rows it met', () => {
    const index = build(1);
    try {
      // Only one page may come back for "tidal". It must be the page with the
      // word in its title, not whichever row the database happened to reach.
      const { results } = search(index, 'tidal');
      assert.equal(results[0].url, 'https://x.example/page-0');
    } finally { index.close(); }
  });
});
