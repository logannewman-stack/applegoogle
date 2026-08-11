import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extract, decodeEntities } from '../src/crawler/extract.js';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Coffee &amp; Brewing — Guide</title>
  <meta name="description" content="A guide to brewing coffee at home.">
  <link rel="canonical" href="https://brew.example.org/guide">
</head>
<body>
  <nav><a href="/nav-link">Menu item</a>NAVIGATION NOISE</nav>
  <h1>Brewing well</h1>
  <p>Grind fresh, pour slowly &mdash; taste often.</p>
  <a href="/next-page">Next page</a>
  <a href="https://other.example/ref" rel="nofollow">Paid link</a>
  <a href="mailto:hi@example.com">Mail</a>
  <script>var ignored = "SCRIPT NOISE";</script>
  <style>.ignored { color: red; }</style>
  <footer>FOOTER NOISE</footer>
</body>
</html>`;

test('extracts title, description, canonical, lang', () => {
  const page = extract(PAGE);
  assert.equal(page.title, 'Coffee & Brewing — Guide');
  assert.equal(page.description, 'A guide to brewing coffee at home.');
  assert.equal(page.canonical, 'https://brew.example.org/guide');
  assert.equal(page.lang, 'en');
  assert.equal(page.noindex, false);
});

test('text excludes script/style/nav/footer noise', () => {
  const { text } = extract(PAGE);
  assert.ok(text.includes('Grind fresh'));
  assert.ok(!text.includes('SCRIPT NOISE'));
  assert.ok(!text.includes('NAVIGATION NOISE'));
  assert.ok(!text.includes('FOOTER NOISE'));
  assert.ok(text.includes('taste often'));
});

test('collects links but skips nofollow and mailto', () => {
  const { links } = extract(PAGE);
  assert.ok(links.includes('/next-page'));
  assert.ok(!links.includes('https://other.example/ref'));
  assert.ok(!links.some((l) => l.startsWith('mailto:')));
});

test('meta robots noindex is honored', () => {
  const page = extract('<html><head><meta name="robots" content="noindex, nofollow"></head><body>x</body></html>');
  assert.equal(page.noindex, true);
});

test('entity decoding', () => {
  assert.equal(decodeEntities('a &amp; b &#8212; c &#x2014; d'), 'a & b — c — d');
});
