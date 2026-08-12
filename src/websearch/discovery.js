// Live discovery: growing the index from what people actually ask.
//
// When a query finds little or nothing locally, Northstar asks a provider for
// candidate URLs, then does the real work itself — fetch each page (obeying
// robots.txt like any other crawl), extract it, index it, recompute authority,
// and re-run the ordinary ranker. The provider's ordering is discarded
// entirely; it only ever supplied addresses.
//
// Two consequences worth stating plainly:
//   1. Ranking stays Northstar's own, so the covenant survives federation.
//   2. The index gets permanently better every time somebody searches.

import { Crawler } from '../crawler/crawler.js';
import { normalizeUrl } from '../core/index.js';
import { getProvider, PROVIDERS } from './providers.js';

export class Discovery {
  constructor(index, config, { fetchImpl = fetch, log = () => {} } = {}) {
    this.index = index;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.crawler = new Crawler(index, config, { fetchImpl, log });
    this.inFlight = new Map(); // query -> Promise, so a stampede fetches once
    this.recent = new Map(); // query -> timestamp, to avoid re-asking constantly
  }

  get enabled() {
    return this.config.webDiscovery === true;
  }

  // Was this query expanded recently enough that asking again is wasteful?
  isCoolingDown(query, now = Date.now()) {
    const last = this.recent.get(query.toLowerCase());
    return last !== undefined && now - last < this.config.discoveryCooldownMs;
  }

  /**
   * Expand the index for `query`. Returns a summary of what was added.
   * Safe to call concurrently: identical queries share one in-flight run.
   */
  async expand(query, { limit = this.config.discoveryLimit, force = false } = {}) {
    if (!this.enabled) {
      throw Object.assign(
        new Error('Web discovery is off. Set WEB_DISCOVERY=1 (and SEARCH_PROVIDER) to let Northstar reach past its own index.'),
        { status: 409, code: 'discovery_disabled' },
      );
    }
    const key = query.trim().toLowerCase();
    if (!key) return { added: 0, considered: 0, provider: null, skipped: 'empty_query' };
    if (!force && this.isCoolingDown(key)) {
      return { added: 0, considered: 0, provider: null, skipped: 'cooling_down' };
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const run = this._expand(query, limit)
      .finally(() => {
        this.inFlight.delete(key);
        this.recent.set(key, Date.now());
      });
    this.inFlight.set(key, run);
    return run;
  }

  async _expand(query, limit) {
    const primary = getProvider(this.config);
    const started = Date.now();

    // A keyless setup depends on machines nobody promised you. When the
    // chosen provider cannot answer, a narrower one that always works beats
    // no answer at all — the user asked a question either way. The fallback
    // only ever supplies addresses, exactly like the primary, so nothing about
    // the ranking changes with it.
    const fallback = this.config.searchFallbackProvider
      && this.config.searchFallbackProvider !== primary.id
      ? PROVIDERS[this.config.searchFallbackProvider]
      : null;

    let provider = primary;
    let candidates = [];
    let fellBackFrom = null;
    try {
      candidates = await primary.discover(query, {
        limit,
        config: this.config,
        fetchImpl: this.fetchImpl,
        log: this.log,
      });
    } catch (err) {
      this.log(`discovery: ${primary.id} failed — ${err.message}`);
      if (!fallback) {
        throw Object.assign(new Error(`Could not reach ${primary.label}: ${err.message}`), {
          status: 502,
          code: 'provider_unreachable',
        });
      }
      this.log(`discovery: falling back to ${fallback.id}`);
      try {
        candidates = await fallback.discover(query, {
          limit,
          config: this.config,
          fetchImpl: this.fetchImpl,
          log: this.log,
        });
        provider = fallback;
        fellBackFrom = primary.id;
      } catch (fallbackErr) {
        throw Object.assign(
          new Error(`Could not reach ${primary.label} (${err.message}) or ${fallback.label} (${fallbackErr.message}).`),
          { status: 502, code: 'provider_unreachable' },
        );
      }
    }

    // Skip anything already indexed; discovery is for what we do not have.
    const fresh = [];
    for (const raw of candidates) {
      const url = normalizeUrl(raw);
      if (!url) continue;
      if (this.index.hasUrl(url)) continue;
      if (!fresh.includes(url)) fresh.push(url);
    }

    if (fresh.length === 0) {
      return { added: 0, considered: candidates.length, provider: provider.id, fellBackFrom, tookMs: Date.now() - started };
    }

    // Fetch and index them ourselves — same politeness rules as any crawl,
    // but concurrently across hosts and bounded by a deadline so a search
    // never hangs waiting for a slow site.
    const deadline = started + this.config.discoveryBudgetMs;
    // Providers routinely name several pages on one host — every Wikipedia
    // result is en.wikipedia.org — and a courtesy gap sized for a bulk crawl
    // then serializes the whole expansion into the budget, so the search comes
    // back with nothing. Someone is waiting on this one, so our own gap
    // shrinks. A Crawl-delay the site actually asked for is still obeyed.
    const stats = await this.crawler.fetchAll(fresh, {
      deadline,
      log: this.log,
      delayMs: this.config.discoveryDelayMs,
    });

    // Anything the deadline cut short is finished after the response goes
    // out, so the index still gets it — just not on this request's clock.
    if (stats.remaining.length > 0) {
      this.log(`${stats.remaining.length} page(s) past the budget — finishing in the background`);
      // Exposed so callers (and tests) can await the tail if they want it.
      this.pending = this.crawler.fetchAll(stats.remaining, { log: this.log })
        .then((late) => {
          if (late.indexed > 0) {
            this.index.computeAuthority();
            this.onBackgroundIndexed?.(late.indexed);
          }
          return late;
        })
        .catch((err) => {
          this.log(`background fetch failed: ${err.message}`);
          return { indexed: 0 };
        });
    }

    return {
      added: stats.indexed,
      considered: candidates.length,
      skipped: stats.skipped,
      errors: stats.errors,
      deferred: stats.remaining.length,
      provider: provider.id,
      fellBackFrom,
      tookMs: Date.now() - started,
    };
  }
}
