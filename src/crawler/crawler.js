// Polite breadth-first crawler.
//
// Politeness rules, non-negotiable:
//   - robots.txt is fetched per origin and obeyed (including Crawl-delay)
//   - at least `delayMs` between any two requests to the same host
//   - honest User-Agent, bounded page size, bounded timeout
//   - meta robots "noindex" pages are crawled for links but never indexed
//
// Behind a corporate/egress proxy, run Node with NODE_USE_ENV_PROXY=1 so the
// built-in fetch honors HTTPS_PROXY (Node >= 22.18).

import { normalizeUrl } from '../core/index.js';
import { extract } from './extract.js';
import { RobotsCache } from './robots.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Crawler {
  constructor(index, config, { log = () => {}, fetchImpl = fetch } = {}) {
    this.index = index;
    this.config = config;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.robots = new RobotsCache({
      userAgent: config.crawlUserAgent,
      timeoutMs: config.crawlTimeoutMs,
      fetchImpl,
    });
    this.lastHitByHost = new Map();
  }

  async politeWait(url) {
    const host = new URL(url).hostname;
    const robotsDelay = await this.robots.crawlDelayFor(url);
    const delayMs = Math.min(
      Math.max(this.config.crawlDelayMs, (robotsDelay ?? 0) * 1000),
      15000,
    );
    const last = this.lastHitByHost.get(host) || 0;
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastHitByHost.set(host, Date.now());
  }

  async fetchPage(url) {
    await this.politeWait(url);
    const res = await this.fetchImpl(url, {
      headers: {
        'user-agent': this.config.crawlUserAgent,
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(this.config.crawlTimeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      throw new Error(`Not HTML (${type.split(';')[0] || 'unknown'})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.config.crawlMaxBytes) {
      throw new Error(`Too large (${buf.byteLength} bytes)`);
    }
    return { html: new TextDecoder().decode(buf), finalUrl: res.url || url };
  }

  // seeds: string[]; options: { maxPages, maxDepth, sameDomain }
  async crawl(seeds, { maxPages = 50, maxDepth = 2, sameDomain = true } = {}) {
    const queue = [];
    const seen = new Set();
    const seedHosts = new Set();
    const stats = { fetched: 0, indexed: 0, skipped: 0, errors: 0 };

    for (const seed of seeds) {
      const url = normalizeUrl(seed);
      if (!url) {
        this.log(`skip (invalid URL): ${seed}`);
        continue;
      }
      seedHosts.add(new URL(url).hostname);
      if (!seen.has(url)) {
        seen.add(url);
        queue.push({ url, depth: 0 });
      }
    }

    while (queue.length > 0 && stats.indexed < maxPages) {
      const { url, depth } = queue.shift();

      try {
        if (!(await this.robots.isAllowed(url))) {
          stats.skipped++;
          this.log(`robots.txt disallows: ${url}`);
          continue;
        }

        const { html, finalUrl } = await this.fetchPage(url);
        stats.fetched++;
        const page = extract(html);

        const canonicalUrl = normalizeUrl(page.canonical || finalUrl, finalUrl) || normalizeUrl(finalUrl);
        seen.add(canonicalUrl);

        if (page.noindex) {
          stats.skipped++;
          this.log(`noindex: ${url}`);
        } else if (!page.title && page.text.length < 80) {
          stats.skipped++;
          this.log(`too thin to index: ${url}`);
        } else {
          this.index.addDocument({
            url: canonicalUrl,
            title: page.title,
            description: page.description,
            text: page.text,
            links: page.links.map((l) => normalizeUrl(l, finalUrl)).filter(Boolean),
            lang: page.lang,
            fetchedAt: new Date().toISOString(),
          });
          stats.indexed++;
          this.log(`indexed [${stats.indexed}/${maxPages}] ${canonicalUrl}`);
        }

        if (depth < maxDepth) {
          for (const raw of page.links) {
            const link = normalizeUrl(raw, finalUrl);
            if (!link || seen.has(link)) continue;
            if (sameDomain && !seedHosts.has(new URL(link).hostname)) continue;
            seen.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      } catch (err) {
        stats.errors++;
        this.log(`error: ${url} — ${err.message}`);
      }
    }

    // Authority is recomputed over the whole graph after every crawl.
    this.index.computeAuthority();
    return stats;
  }
}
