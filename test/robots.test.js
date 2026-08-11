import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRobots } from '../src/crawler/robots.js';

const UA = 'applegoogle-crawler/0.1';

test('empty robots allows everything', () => {
  const robots = parseRobots('', UA);
  assert.equal(robots.isAllowed('/anything'), true);
});

test('basic disallow', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /private/', UA);
  assert.equal(robots.isAllowed('/private/page'), false);
  assert.equal(robots.isAllowed('/public/page'), true);
});

test('longest match wins, ties go to allow', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /shop/\nAllow: /shop/catalog/', UA);
  assert.equal(robots.isAllowed('/shop/cart'), false);
  assert.equal(robots.isAllowed('/shop/catalog/item'), true);
});

test('wildcards and end anchors', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*', UA);
  assert.equal(robots.isAllowed('/report.pdf'), false);
  assert.equal(robots.isAllowed('/report.pdfx'), true);
  assert.equal(robots.isAllowed('/tmp-files/a'), false);
});

test('specific user-agent group overrides *', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: applegoogle-crawler\nDisallow: /nope/';
  const robots = parseRobots(text, UA);
  assert.equal(robots.isAllowed('/fine'), true);
  assert.equal(robots.isAllowed('/nope/x'), false);
});

test('stacked user-agent lines share one group', () => {
  const text = 'User-agent: a-bot\nUser-agent: *\nDisallow: /x/';
  const robots = parseRobots(text, UA);
  assert.equal(robots.isAllowed('/x/1'), false);
});

test('crawl-delay is parsed', () => {
  const robots = parseRobots('User-agent: *\nCrawl-delay: 4\nDisallow: /a', UA);
  assert.equal(robots.crawlDelay, 4);
});

test('empty Disallow means allow all', () => {
  const robots = parseRobots('User-agent: *\nDisallow:', UA);
  assert.equal(robots.isAllowed('/whatever'), true);
});
