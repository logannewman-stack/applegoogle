import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { scoreDocuments, search, makeSnippet, RANKING_SIGNALS, EXCLUDED_FOREVER } from '../src/core/ranker.js';

const memoryStore = () => ({ data: emptyIndexData(), save: async () => {} });

function buildIndex(docs) {
  const index = new SearchIndex(memoryStore());
  for (const d of docs) {
    index.addDocument({ description: '', links: [], fetchedAt: '2026-08-01T00:00:00.000Z', ...d });
  }
  return index;
}

test('a title match outranks a body-only match', () => {
  const index = buildIndex([
    { url: 'https://x.example/title', title: 'Sourdough starter guide', text: 'Keeping yeast happy at home.' },
    { url: 'https://x.example/body', title: 'Weekend baking notes', text: 'I fed my sourdough starter twice and baked a loaf.' },
    { url: 'https://x.example/none', title: 'Espresso', text: 'Pulling shots.' },
  ]);
  const { results } = search(index, 'sourdough starter');
  assert.equal(results[0].url, 'https://x.example/title');
  assert.ok(results.every((r) => r.url !== 'https://x.example/none'));
});

test('matching more of the query outranks matching less', () => {
  const index = buildIndex([
    { url: 'https://x.example/full', title: 'Electric vehicle charging basics', text: 'Level 2 charging at home overnight.' },
    { url: 'https://x.example/partial', title: 'Vehicle maintenance', text: 'Rotate tires and check brakes on any vehicle regularly and often.' },
  ]);
  const { results } = search(index, 'electric vehicle charging');
  assert.equal(results[0].url, 'https://x.example/full');
});

test('adjacent phrases beat scattered words', () => {
  const base = 'filler words to keep document lengths roughly comparable in this test';
  const index = buildIndex([
    { url: 'https://x.example/phrase', title: 'Notes', text: `${base} the event loop explained clearly ${base}` },
    { url: 'https://x.example/scattered', title: 'Notes', text: `${base} an event at the venue had a loop of rope ${base}` },
  ]);
  const { results } = search(index, 'event loop');
  assert.equal(results[0].url, 'https://x.example/phrase');
});

test('link authority breaks ties between equally relevant pages', () => {
  const index = buildIndex([
    { url: 'https://x.example/linked', title: 'Closure guide', text: 'Functions remember their scope.' },
    { url: 'https://x.example/lonely', title: 'Closure guide', text: 'Functions remember their scope.' },
    { url: 'https://x.example/a', title: 'Links page', text: 'Recommended reading list.', links: ['https://x.example/linked'] },
    { url: 'https://x.example/b', title: 'More links', text: 'Another reading list.', links: ['https://x.example/linked'] },
  ]);
  index.computeAuthority();
  const { results } = search(index, 'closure guide');
  assert.equal(results[0].url, 'https://x.example/linked');
});

// ── The promise that defines the product ─────────────────────────────────────
// Money must have no path into ranking. If someone bolts sponsorship fields
// onto documents, every score must come out identical.
test('INTEGRITY: sponsorship-style fields cannot change any score', () => {
  const docs = [
    { url: 'https://x.example/one', title: 'Pour over coffee', text: 'Grind, bloom, pour.' },
    { url: 'https://x.example/two', title: 'Coffee roasting', text: 'Light roasts and pour over brewing.' },
    { url: 'https://x.example/three', title: 'Coffee shops', text: 'Places that serve pour over.' },
  ];
  const index = buildIndex(docs);
  const before = scoreDocuments(index, 'pour over coffee', { now: 1754956800000 });

  for (const id in index.data.docs) {
    Object.assign(index.data.docs[id], {
      sponsored: true,
      adBudget: 1e9,
      paidBoost: 9999,
      partnerTier: 'platinum',
    });
  }
  const after = scoreDocuments(index, 'pour over coffee', { now: 1754956800000 });

  assert.deepEqual(after.scored, before.scored, 'scores moved after injecting sponsorship fields');
});

test('the published ranking manifest stays honest', () => {
  const ids = RANKING_SIGNALS.map((s) => s.id);
  assert.deepEqual(ids, ['text_relevance', 'phrase_proximity', 'link_authority', 'freshness']);
  assert.ok(EXCLUDED_FOREVER.some((line) => /paid|sponsor|payment/i.test(line)));
});

test('snippets center on query matches', () => {
  const text = `${'Unrelated preamble sentence. '.repeat(30)}The sourdough starter doubles within six hours when healthy. ${'Trailing filler. '.repeat(30)}`;
  const snippet = makeSnippet(text, ['sourdough', 'starter']);
  assert.ok(snippet.includes('sourdough starter'));
  assert.ok(snippet.length <= 260);
});

test('domain diversity keeps one site from owning the page', () => {
  const docs = [];
  for (let i = 0; i < 8; i++) {
    docs.push({ url: `https://mono.example/page-${i}`, title: 'Hiking guide', text: 'Trail hiking advice and gear.' });
  }
  docs.push({ url: 'https://other.example/hiking', title: 'Hiking guide', text: 'Trail hiking advice and gear.' });
  const index = buildIndex(docs);
  const { results } = search(index, 'hiking guide', { perPage: 4 });
  assert.ok(
    results.slice(0, 4).some((r) => r.domain === 'other.example'),
    'a second domain should appear in the top results',
  );
});
