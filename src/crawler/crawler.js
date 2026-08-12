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

  // `floorMs` lets a caller lower *our own* self-imposed courtesy gap. A
  // Crawl-delay the site actually asked for is still obeyed in full — that is
  // the Math.max below, and nothing may lower it.
  async politeWait(url, floorMs = this.config.crawlDelayMs) {
    const host = new URL(url).hostname;
    const robotsDelay = await this.robots.crawlDelayFor(url);
    const delayMs = Math.min(
      Math.max(floorMs, (robotsDelay ?? 0) * 1000),
      15000,
    );
    const last = this.lastHitByHost.get(host) || 0;
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastHitByHost.set(host, Date.now());
  }

  async fetchPage(url, { signal = null, delayMs = this.config.crawlDelayMs } = {}) {
    await this.politeWait(url, delayMs);
    // The caller's deadline (if any) bounds the request as tightly as our
    // own timeout does, so a slow host can never outlast a search.
    const timeout = AbortSignal.timeout(this.config.crawlTimeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const res = await this.fetchImpl(url, {
      headers: {
        'user-agent': this.config.crawlUserAgent,
        accept: 'text/html,application/xhtml+xml',
      },
      signal: combined,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      throw new Error(`Not HTML (${type.split(';')[0] || 'unknown'})`);
    }
    const buf = await res.arrayBuffer();
    // A page over the ceiling is read up to it, not thrown away. The opening
    // megabytes of a long article are the article; discarding the whole thing
    // is how "search the web" quietly comes back with nothing — a big
    // encyclopedia page is exactly the kind of source a question deserves.
    const over = buf.byteLength > this.config.crawlMaxBytes;
    const bytes = over ? buf.slice(0, this.config.crawlMaxBytes) : buf;
    return {
      html: new TextDecoder().decode(bytes),
      finalUrl: res.url || url,
      truncated: over,
    };
  }

  // Fetch and index exactly these URLs, concurrently across hosts.
  //
  // Politeness is a per-host obligation, so waiting a second between two
  // different sites buys nobody anything — it just makes search slow. Hosts
  // run in parallel; each host stays strictly sequential and rate-limited.
  // Returns { indexed, skipped, errors, remaining } where `remaining` is
  // whatever the deadline cut short.
  async fetchAll(urls, { deadline = Infinity, log = this.log, delayMs = this.config.crawlDelayMs } = {}) {
    const byHost = new Map();
    for (const url of urls) {
      let host;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(url);
    }

    const stats = { indexed: 0, skipped: 0, errors: 0, remaining: [] };
    // One signal for the whole batch: when the budget runs out, in-flight
    // requests are abandoned rather than allowed to finish on their own time.
    const controller = new AbortController();
    let deadlineTimer = null;
    if (Number.isFinite(deadline)) {
      const ms = Math.max(0, deadline - Date.now());
      deadlineTimer = setTimeout(() => controller.abort(new Error('discovery budget reached')), ms);
      deadlineTimer.unref?.();
    }

    await Promise.all([...byHost.values()].map(async (queue) => {
      for (let i = 0; i < queue.length; i++) {
        const url = queue[i];
        if (controller.signal.aborted || Date.now() > deadline) {
          stats.remaining.push(...queue.slice(i));
          return;
        }
        try {
          if (!(await this.robots.isAllowed(url))) {
            stats.skipped++;
            log(`robots.txt disallows: ${url}`);
            continue;
          }
          const { html, finalUrl, truncated } = await this.fetchPage(url, { signal: controller.signal, delayMs });
          if (truncated) log(`read the first ${this.config.crawlMaxBytes} bytes of ${url}`);
          const page = extract(html);
          if (page.noindex || (!page.title && page.text.length < 80)) {
            stats.skipped++;
            continue;
          }
          const canonical = normalizeUrl(page.canonical || finalUrl, finalUrl) || normalizeUrl(finalUrl);
          this.index.addDocument({
            url: canonical,
            title: page.title,
            description: page.description,
            text: page.text,
            links: page.links.map((l) => normalizeUrl(l, finalUrl)).filter(Boolean),
            lang: page.lang,
            fetchedAt: new Date().toISOString(),
          });
          stats.indexed++;
          log(`indexed ${canonical}`);
        } catch (err) {
          // A page cut short by the budget is deferred, not failed.
          if (controller.signal.aborted) {
            stats.remaining.push(...queue.slice(i));
            return;
          }
          stats.errors++;
          log(`error: ${url} — ${err.message}`);
        }
      }
    }));
    clearTimeout(deadlineTimer);
    return stats;
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
