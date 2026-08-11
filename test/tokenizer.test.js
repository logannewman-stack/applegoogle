import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, stem, contentTerms, normalize } from '../src/core/tokenizer.js';

test('normalize lowercases and strips diacritics', () => {
  assert.equal(normalize('Café CRÈME'), 'cafe creme');
});

test('stemming maps inflected forms to the same stem', () => {
  const pairs = [
    ['run', 'running'],
    ['search', 'searching'],
    ['search', 'searched'],
    ['code', 'coding'],
    ['engine', 'engines'],
    ['apple', 'apples'],
    ['study', 'studies'],
    ['rank', 'ranked'],
    ['class', 'classes'],
    ['fall', 'falling'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(stem(a), stem(b), `${a} and ${b} should share a stem`);
  }
});

test('tokenize splits on punctuation and returns stems', () => {
  const tokens = tokenize('Brewing pour-over coffee, slowly!');
  assert.ok(tokens.includes(stem('brewing')));
  assert.ok(tokens.includes('pour'));
  assert.ok(tokens.includes(stem('coffee')));
});

test('tokenize with surfaces keeps the original word', () => {
  const [first] = tokenize('Running', { surfaces: true });
  assert.equal(first.surface, 'running');
  assert.equal(first.token, 'run');
});

test('contentTerms drops stopwords but never returns empty', () => {
  const tokens = tokenize('the best coffee');
  const content = contentTerms(tokens);
  assert.ok(!content.includes('the'));
  assert.ok(content.includes(stem('coffee')));

  const onlyStops = tokenize('the of and');
  assert.ok(contentTerms(onlyStops).length > 0, 'all-stopword queries still search');
});
