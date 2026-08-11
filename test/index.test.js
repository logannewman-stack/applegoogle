import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex, emptyIndexData, normalizeUrl } from '../src/core/index.js';

const memoryStore = () => ({ data: emptyIndexData(), save: async () => {} });

const doc = (url, title, text, links = []) => ({
  url, title, description: '', text, links, fetchedAt: '2026-08-01T00:00:00.000Z',
});

test('normalizeUrl strips fragments, tracking params, and normalizes host', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.COM/path?utm_source=x&id=2#section'),
    'https://example.com/path?id=2',
  );
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('/relative', 'https://example.com/base/'), 'https://example.com/relative');
  assert.equal(normalizeUrl('ftp://example.com/file'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('documents are indexed and countable', () => {
  const index = new SearchIndex(memoryStore());
  index.addDocument(doc('https://a.example/1', 'Coffee brewing', 'How to brew coffee well.'));
  index.addDocument(doc('https://a.example/2', 'Tea', 'Steeping green tea.'));
  assert.equal(index.docCount, 2);
  assert.ok(index.termCount > 0);
  assert.equal(index.documentFrequency('coffe'), 1); // stem of "coffee"
});

test('re-adding the same URL replaces the old document', () => {
  const index = new SearchIndex(memoryStore());
  const first = index.addDocument(doc('https://a.example/1', 'Old title', 'Old body.'));
  const second = index.addDocument(doc('https://a.example/1', 'New title', 'New body.'));
  assert.notEqual(first, second);
  assert.equal(index.docCount, 1);
  assert.ok(index.data.docs[first].removed);

  index.compact();
  assert.equal(index.data.docs[first], undefined);
  for (const term in index.data.postings) {
    assert.equal(index.data.postings[term].docs[first], undefined, `compact left posting for ${term}`);
  }
});

test('computeAuthority rewards pages that others link to', () => {
  const index = new SearchIndex(memoryStore());
  index.addDocument(doc('https://a.example/hub', 'Hub', 'The popular page.', []));
  index.addDocument(doc('https://a.example/one', 'One', 'Links to hub.', ['https://a.example/hub']));
  index.addDocument(doc('https://a.example/two', 'Two', 'Also links to hub.', ['https://a.example/hub']));
  index.computeAuthority();

  const byUrl = {};
  for (const id in index.data.docs) byUrl[index.data.docs[id].url] = index.data.docs[id];
  assert.equal(byUrl['https://a.example/hub'].authority, 1, 'most-linked page holds top authority');
  assert.ok(byUrl['https://a.example/one'].authority < 1);
});
