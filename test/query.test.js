import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery, editDistance, nearestTerm } from '../src/core/query.js';
import { SearchIndex, emptyIndexData } from '../src/core/index.js';
import { search } from '../src/core/ranker.js';

const memoryStore = () => ({ data: emptyIndexData(), save: async () => {} });
function buildIndex(docs) {
  const index = new SearchIndex(memoryStore());
  for (const d of docs) {
    index.addDocument({ description: '', links: [], fetchedAt: '2026-08-10T00:00:00.000Z', ...d });
  }
  return index;
}

test('parseQuery pulls phrases, exclusions, and site out of free text', () => {
  const q = parseQuery('pour over "grind size" -decaf site:brew.example.org');
  assert.equal(q.free, 'pour over');
  assert.deepEqual(q.phrases.map((p) => p.surface), ['grind size']);
  assert.deepEqual(q.excluded.map((e) => e.surface), ['decaf']);
  assert.equal(q.site, 'brew.example.org');
  assert.equal(q.hasOperators, true);
  // Phrase words still drive relevance.
  assert.ok(q.terms.includes('grind'));
});

test('plain queries carry no operators', () => {
  const q = parseQuery('pour over coffee');
  assert.equal(q.hasOperators, false);
  assert.equal(q.site, null);
  assert.equal(q.phrases.length, 0);
});

test('quoting protects operator-looking text', () => {
  const q = parseQuery('"site:example.org" is a filter');
  assert.equal(q.site, null, 'a quoted site: is literal text, not a filter');
  assert.equal(q.phrases.length, 1);
});

test('editDistance is bounded and correct', () => {
  assert.equal(editDistance('polaris', 'polaris'), 0);
  assert.equal(editDistance('polarus', 'polaris'), 1);
  assert.equal(editDistance('coffe', 'coffee'), 1);
  assert.ok(editDistance('aaaa', 'zzzzzzzz', 2) > 2, 'bails out past the budget');
});

test('phrase search requires the words adjacent and in order', () => {
  const index = buildIndex([
    { url: 'https://a.example/1', title: 'Light pollution', text: 'What we lost to light pollution at night.' },
    { url: 'https://a.example/2', title: 'Scattered', text: 'The pollution of the harbour and the light of dawn.' },
  ]);
  const loose = search(index, 'light pollution');
  assert.equal(loose.total, 2, 'unquoted matches both');

  const strict = search(index, '"light pollution"');
  assert.equal(strict.total, 1);
  assert.equal(strict.results[0].url, 'https://a.example/1');
  assert.deepEqual(strict.operators.phrases, ['light pollution']);
  assert.ok(
    strict.results[0].why.reasons.some((r) => r.signal === 'operator' && /exact phrase/i.test(r.text)),
    'the star explains the phrase requirement',
  );
});

test('minus removes pages containing the word', () => {
  const index = buildIndex([
    { url: 'https://a.example/1', title: 'Coffee guide', text: 'Brewing coffee with espresso and milk.' },
    { url: 'https://a.example/2', title: 'Coffee at home', text: 'Brewing coffee gently with a filter.' },
  ]);
  const all = search(index, 'coffee');
  assert.equal(all.total, 2);

  const filtered = search(index, 'coffee -espresso');
  assert.equal(filtered.total, 1);
  assert.equal(filtered.results[0].url, 'https://a.example/2');
  assert.deepEqual(filtered.operators.excluded, ['espresso']);
});

test('site: restricts to one host and its subdomains', () => {
  const index = buildIndex([
    { url: 'https://sky.example.org/a', title: 'Stars', text: 'Navigating by the stars.' },
    { url: 'https://docs.sky.example.org/b', title: 'More stars', text: 'Star charts and the stars above.' },
    { url: 'https://other.example.net/c', title: 'Stars elsewhere', text: 'Stars in another sky.' },
  ]);
  const scoped = search(index, 'site:sky.example.org stars');
  assert.equal(scoped.total, 2, 'the host and its subdomain, nothing else');
  assert.ok(scoped.results.every((r) => r.domain.endsWith('sky.example.org')));
  assert.equal(scoped.operators.site, 'sky.example.org');
});

test('operators can only remove pages, never promote one', () => {
  const docs = [
    { url: 'https://a.example/1', title: 'Grind size', text: 'Grind size is the dial that matters most.' },
    { url: 'https://a.example/2', title: 'Water', text: 'Water is most of your coffee and grind size matters.' },
    { url: 'https://a.example/3', title: 'Beans', text: 'Storing beans well, and grind size at the end.' },
  ];
  const index = buildIndex(docs);
  const plain = search(index, 'grind size', { now: 1786000000000 });
  const scoped = search(index, 'site:a.example grind size', { now: 1786000000000 });
  assert.deepEqual(
    scoped.results.map((r) => r.url),
    plain.results.map((r) => r.url),
    'a filter that removes nothing must not reorder anything',
  );
  assert.deepEqual(scoped.results.map((r) => r.score), plain.results.map((r) => r.score));
});

test('a misspelling searches what was meant, and offers the literal back', () => {
  const index = buildIndex([
    { url: 'https://sky.example.org/p', title: 'Finding Polaris', text: 'Polaris marks true north for navigators.' },
  ]);
  const fixed = search(index, 'polarus');
  assert.ok(fixed.correction, 'a correction is offered');
  assert.equal(fixed.correction.query, 'polaris');
  assert.equal(fixed.correction.from, 'polarus');
  assert.equal(fixed.total, 1);

  const literal = search(index, 'polarus', { allowCorrection: false });
  assert.equal(literal.correction, null);
  assert.equal(literal.total, 0, 'the literal search really is literal');
});

test('correctly spelled queries are never rewritten', () => {
  const index = buildIndex([
    { url: 'https://sky.example.org/p', title: 'Finding Polaris', text: 'Polaris marks true north.' },
  ]);
  assert.equal(search(index, 'polaris').correction, null);
});

test('nearestTerm will not turn a short word into a different one', () => {
  const index = buildIndex([
    { url: 'https://a.example/1', title: 'Cars', text: 'A car and a cat walked in.' },
  ]);
  // "bat" is 1 edit from "cat", but the first letter differs — too risky.
  assert.equal(nearestTerm(index, 'bat'), null);
  // A same-first-letter typo is corrected.
  assert.equal(nearestTerm(index, 'cart'), 'car');
});

test('pagination reports its position honestly', () => {
  const docs = [];
  for (let i = 0; i < 25; i++) {
    docs.push({ url: `https://a.example/${i}`, title: `Star chart ${i}`, text: 'Charts of the stars and the sky.' });
  }
  const index = buildIndex(docs);
  const page2 = search(index, 'stars', { page: 2, perPage: 10 });
  assert.equal(page2.total, 25);
  assert.equal(page2.totalPages, 3);
  assert.equal(page2.page, 2);
  assert.equal(page2.results.length, 10);

  const page3 = search(index, 'stars', { page: 3, perPage: 10 });
  assert.equal(page3.results.length, 5, 'the last page is the remainder');

  // No duplicates across pages.
  const seen = new Set([...page2.results, ...page3.results].map((r) => r.url));
  assert.equal(seen.size, 15);
});
