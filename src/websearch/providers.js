// Discovery providers.
//
// A provider's ONLY job is to name candidate URLs for a query. It never
// decides what ranks where — Northstar fetches each page itself, indexes it,
// and scores it with its own signals. That distinction is the whole point:
// borrowing someone else's *index* would mean borrowing whatever commercial
// pressure shaped it, and the covenant in INTEGRITY.md would be a fiction.
// Borrowing a list of addresses borrows nothing but the addresses.
//
// Providers are chosen with SEARCH_PROVIDER. Wikipedia needs no key and works
// anywhere; the rest need an API key from the respective service.

const UA = 'northstar-discovery/0.3 (+https://github.com/logannewman-stack/applegoogle)';

async function getJson(url, { headers = {}, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`Provider responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── SearXNG ───────────────────────────────────────────────────────────
// Open-source metasearch. No key, no account, and it covers the whole web,
// which makes it the fastest honest way to get Northstar searching properly.
// Point it at public instances (SEARXNG_URL takes a comma-separated list),
// or run your own in one command, which is better in every way:
//
//   docker compose up -d
//
// The repo ships the settings that make a stock SearXNG answer a program at
// all: the JSON API enabled, and the bot limiter off. Without both, requests
// come back as web pages or 403s.
//
// SEARXNG_URL takes a comma-separated list, not just one address. Any single
// public instance is unreliable — the JSON API gets switched off, the rate
// limiter trips, the host goes down for a weekend — but the pool as a whole is
// dependable. Northstar tries them in order and stops at the first that
// answers, so a list of five is a keyless whole-web search that stays up.
export function searxngInstances(config = {}) {
  return String(config.searxngUrl || 'http://localhost:8888')
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Whichever instance answered last is tried first next time, so a dead one at
// the head of the list is not re-paid for on every single search.
let lastGoodInstance = null;

export const searxng = {
  id: 'searxng',
  needsKey: false,
  label: 'SearXNG (open metasearch, no key)',
  async discover(query, { limit = 8, config = {}, fetchImpl = fetch, log = () => {} } = {}) {
    const all = searxngInstances(config);
    // Put the last known-good instance first without dropping the others.
    const ordered = lastGoodInstance && all.includes(lastGoodInstance)
      ? [lastGoodInstance, ...all.filter((u) => u !== lastGoodInstance)]
      : all;

    const failures = [];
    for (const base of ordered) {
      const api = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
      try {
        const data = await getJson(api, { fetchImpl, timeoutMs: config.crawlTimeoutMs || 10000 });
        const urls = (data?.results || []).map((r) => r.url).filter(Boolean).slice(0, limit);
        // A 200 with nothing in it is a rate limiter being polite about
        // refusing. Treat it as a failure and try the next instance.
        if (urls.length === 0) {
          failures.push(`${base}: answered with no results`);
          continue;
        }
        lastGoodInstance = base;
        if (ordered.length > 1) log(`searxng: ${base} answered with ${urls.length} URL(s)`);
        return urls;
      } catch (err) {
        // The commonest failure by far: an instance that serves HTML but has
        // the JSON format switched off.
        failures.push(`${base}: ${err.status === 403 || err.status === 404 ? 'JSON API disabled' : err.message}`);
      }
    }

    throw Object.assign(
      new Error(
        `No SearXNG instance answered (tried ${ordered.length}).\n  `
        + failures.join('\n  ')
        + '\n\nFind instances that work: npm run find-searxng'
        + '\nOr run your own, which never rate-limits you and needs no account:'
        + '\n  docker compose up -d',
      ),
      { status: 502, code: 'searxng_unreachable' },
    );
  },
};

// ── Wikipedia / MediaWiki ─────────────────────────────────────────────
// Keyless and open. A good default: real, substantial, crawlable pages.
export const wikipedia = {
  id: 'wikipedia',
  needsKey: false,
  label: 'Wikipedia',
  async discover(query, { limit = 8, config = {}, fetchImpl = fetch } = {}) {
    const host = config.wikipediaHost || 'en.wikipedia.org';
    const api = `https://${host}/w/api.php?action=query&format=json&origin=*`
      + `&generator=search&gsrlimit=${limit}&gsrsearch=${encodeURIComponent(query)}`
      + '&prop=info&inprop=url';
    const data = await getJson(api, { fetchImpl });
    const pages = data?.query?.pages || {};
    return Object.values(pages)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((p) => p.fullurl)
      .filter(Boolean)
      .slice(0, limit);
  },
};

// ── Brave Search API ──────────────────────────────────────────────────
export const brave = {
  id: 'brave',
  needsKey: true,
  label: 'Brave Search',
  keyEnv: 'BRAVE_API_KEY',
  async discover(query, { limit = 8, config = {}, fetchImpl = fetch } = {}) {
    const api = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const data = await getJson(api, {
      headers: { 'x-subscription-token': config.searchApiKey },
      fetchImpl,
    });
    return (data?.web?.results || []).map((r) => r.url).filter(Boolean).slice(0, limit);
  },
};

// ── Google Programmable Search ────────────────────────────────────────
export const googleCse = {
  id: 'google',
  needsKey: true,
  label: 'Google Programmable Search',
  keyEnv: 'GOOGLE_API_KEY (plus GOOGLE_CSE_ID)',
  async discover(query, { limit = 8, config = {}, fetchImpl = fetch } = {}) {
    const api = 'https://www.googleapis.com/customsearch/v1'
      + `?key=${encodeURIComponent(config.searchApiKey)}`
      + `&cx=${encodeURIComponent(config.searchEngineId)}`
      + `&num=${Math.min(10, limit)}&q=${encodeURIComponent(query)}`;
    const data = await getJson(api, { fetchImpl });
    return (data?.items || []).map((i) => i.link).filter(Boolean).slice(0, limit);
  },
};

// ── Bing Web Search ───────────────────────────────────────────────────
// Microsoft announced the retirement of the Bing Search APIs (August 2025).
// Kept because self-hosted and legacy endpoints still answer for some
// customers, but do not build on it — check availability before choosing it.
export const bing = {
  id: 'bing',
  needsKey: true,
  retired: true,
  label: 'Bing Web Search (retired by Microsoft — verify availability)',
  keyEnv: 'BING_API_KEY',
  async discover(query, { limit = 8, config = {}, fetchImpl = fetch } = {}) {
    const api = `https://api.bing.microsoft.com/v7.0/search?count=${limit}&q=${encodeURIComponent(query)}`;
    const data = await getJson(api, {
      headers: { 'ocp-apim-subscription-key': config.searchApiKey },
      fetchImpl,
    });
    return (data?.webPages?.value || []).map((r) => r.url).filter(Boolean).slice(0, limit);
  },
};

export const PROVIDERS = { searxng, wikipedia, brave, google: googleCse, bing };

// Guidance shown by `npm run setup:web`. Costs move — verify before relying
// on them; these are recorded as of the last time this file was touched.
export const PROVIDER_NOTES = {
  searxng: {
    recommended: true,
    independence: 'Open-source metasearch you can run yourself. No key, no account, whole-web coverage.',
    cost: 'Free. Self-host with one docker command, or use a public instance.',
    signup: 'docker compose up -d  (config ships in the repo — JSON API on, bot limiter off)',
  },
  brave: {
    recommended: false,
    independence: 'Independent index — Brave runs its own crawler, so Northstar is not quietly asking Google.',
    cost: 'Free tier available (~2k queries/month at time of writing), paid tiers beyond that.',
    signup: 'https://brave.com/search/api/',
  },
  wikipedia: {
    recommended: false,
    independence: 'Fully open, no key, no account — but encyclopedia content only.',
    cost: 'Free.',
    signup: 'No signup needed.',
  },
  google: {
    recommended: false,
    independence: 'Google’s index. Broadest coverage, but your independent engine is calling Google.',
    cost: '~100 queries/day free, paid per thousand beyond that, with a daily cap.',
    signup: 'https://programmablesearchengine.google.com/ (also needs GOOGLE_CSE_ID)',
  },
  bing: {
    recommended: false,
    independence: 'Microsoft’s index.',
    cost: 'Retired by Microsoft in 2025 — verify it is still available to you before choosing it.',
    signup: 'https://www.microsoft.com/en-us/bing/apis',
  },
};

export function getProvider(config) {
  const provider = PROVIDERS[config.searchProvider];
  if (!provider) {
    throw Object.assign(
      new Error(`Unknown SEARCH_PROVIDER '${config.searchProvider}'. Available: ${Object.keys(PROVIDERS).join(', ')}.`),
      { status: 400, code: 'unknown_provider' },
    );
  }
  if (provider.needsKey && !config.searchApiKey) {
    throw Object.assign(
      new Error(`${provider.label} needs an API key — set ${provider.keyEnv}. Or use SEARCH_PROVIDER=wikipedia, which needs none.`),
      { status: 400, code: 'missing_provider_key' },
    );
  }
  if (provider.id === 'google' && !config.searchEngineId) {
    throw Object.assign(new Error('Google Programmable Search also needs GOOGLE_CSE_ID.'), {
      status: 400,
      code: 'missing_provider_key',
    });
  }
  return provider;
}
