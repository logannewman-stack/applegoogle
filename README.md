# ✦ Northstar

A search engine built on one idea: **if the searcher pays, the searcher is the
only customer.** No ads. No sponsored results. No paid placement — there is no
code path for money to touch a ranking, and [a test enforces that](INTEGRITY.md).
Revenue is subscriptions, so the engine makes money only by being useful.

And because trust needs receipts, **every result explains itself**: Northstar
tells you exactly why each page was chosen for your query — which of your
words matched, where they matched, whether the exact phrase appears, how many
other pages link there, and how fresh it is.

The design target is "Google, if Apple designed it": monochrome, quiet, and
nothing on the page that isn't the answer.

> The GitHub repository is still named `applegoogle` from the working title —
> rename it to `northstar` any time in GitHub → Settings (links redirect
> automatically).

## Quick start

Requires Node 22+. No dependencies to install — the entire backend is
standard-library Node.

```bash
npm run seed     # load sample documents so search works immediately
npm start        # http://127.0.0.1:3000
npm test         # 45 tests, including the ranking-integrity test
```

Open http://127.0.0.1:3000 and search for *pour over coffee*, *closures*, or
*ad-free search*. Click **Why this result ▸** under any hit.

## What the product does

- **Explains every result.** Each hit carries a `why` object — a plain-language
  summary plus the numeric factors behind the score. The full ranking formula
  is public API at `GET /v1/ranking`.
- **Tabs.** The web app is a small browser: multiple search tabs, each with its
  own query and results, restored (with cached results) when you come back.
- **History.** Searches are remembered server-side against your account, or an
  anonymous `ns_session` cookie — so *you* can find your way back. It is never
  used for ranking, never for ads (there are none), and one click clears it.
  **Private mode** (footer toggle, or `&private=1`) skips history entirely.
- **Fast.** Repeated queries answer from an in-memory LRU cache (`x-cache:
  hit`), invalidated automatically whenever the index changes; IDF is computed
  once per query; suggestions come from a cached frequency-sorted dictionary.
- **Subscription-funded.** Anonymous visitors get 25 searches/day, free
  accounts 100, subscribers effectively unlimited. When an allowance runs out
  the API answers `402` with the upgrade path — that response *is* the
  business model.

## Why a result is chosen (the receipt)

```json
"why": {
  "summary": "Matches all 3 of your search terms; “pour” and “coffee” appear in the title; contains the exact phrase “pour over”; 2 other indexed pages link here; crawled today.",
  "matched": { "terms": ["pour", "over", "coffee"], "of": 3, "missing": [],
               "inTitle": ["pour", "coffee"], "inDescription": [] },
  "exactPhrase": "pour over",
  "inboundLinks": 2,
  "factors": { "textRelevance": 4.206, "linkAuthority": 1.12,
               "phraseProximity": 1.2, "freshness": 1.05 }
}
```

## Crawl the real web

```bash
npm run crawl -- https://example.com --max-pages=50 --depth=2
```

The crawler is polite by construction: it obeys `robots.txt` (including
`Crawl-delay`), waits ≥1s between hits to the same host, sends an honest
User-Agent (`northstar-crawler`), honors `noindex` and `nofollow`, and bounds
page size and time. Behind an egress proxy, prefix with `NODE_USE_ENV_PROXY=1`
so Node's fetch uses `HTTPS_PROXY`.

## Architecture

```
                 ┌─────────────────────────────────────────┐
   seeds/ ─────► │             SearchIndex                 │
                 │  inverted index · positions · field     │
   crawler ────► │  hits · PageRank + inlink counts ·      │
   robots.txt    │  JSON on disk (atomic writes)           │
   politeness    └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │              Ranker                     │
                 │  BM25F (title 3×, desc 1.5×, body 1×)   │
                 │  × link authority × phrase proximity    │
                 │  × freshness — and nothing else, ever   │
                 │  → every result gets a `why` receipt    │
                 └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │            HTTP API (node:http)         │
                 │  /v1/search (+LRU cache) · /v1/suggest  │
                 │  /v1/ranking · /v1/history · accounts   │
                 │  API keys · subscriptions · sessions    │
                 └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │        Web app (public/index.html)      │
                 │  monochrome · tabs w/ cached results ·  │
                 │  history · why-panels · private mode    │
                 └─────────────────────────────────────────┘
```

| Path | What it is |
| --- | --- |
| `src/core/tokenizer.js` | Normalization, light stemming, stopword handling |
| `src/core/index.js` | Inverted index, field hit tracking, PageRank + inlinks |
| `src/core/ranker.js` | Scoring, snippets, diversity, `why` receipts — the trust core |
| `src/crawler/` | robots.txt parser, HTML extraction, polite BFS crawler |
| `src/api/` | HTTP app, accounts/keys, subscriptions, history, sessions |
| `public/index.html` | The Northstar web app |
| `test/` | 45 tests, run with `npm test` |

## API

```bash
# Search (why-receipts included on every result)
curl 'localhost:3000/v1/search?q=pour+over+coffee'

# Private search — never recorded to history
curl 'localhost:3000/v1/search?q=pour+over+coffee&private=1'

# Your history (account key, or ns_session cookie for anonymous sessions)
curl 'localhost:3000/v1/history' -H 'Authorization: Bearer ns_…'
curl -X DELETE 'localhost:3000/v1/history'                  # clear all
curl -X DELETE 'localhost:3000/v1/history?query=old+search' # remove one

# The public ranking formula — the trust feature
curl 'localhost:3000/v1/ranking'

# Create an account (returns an API key, shown once)
curl -X POST localhost:3000/v1/account \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'

# Subscribe (dev-mode activation until payments are wired in)
curl -X POST localhost:3000/v1/subscribe \
  -H 'Authorization: Bearer ns_…' -H 'content-type: application/json' \
  -d '{"plan":"monthly"}'
```

Also: `GET /v1/suggest?q=`, `GET /v1/plans`, `GET /v1/stats`, `GET /v1/account`,
`POST /v1/subscribe/cancel`, `GET /health`.

## Privacy stance

- History exists for you, keyed to your account or an anonymous first-party
  `ns_session` cookie (a random id, nothing else, httpOnly).
- It is deletable in one call, capped at 200 entries, expired after 90 days.
- Usage counters exist only to enforce daily limits and are kept 7 days.
- Nothing is sold, because the subscription *is* the revenue.

## What's honest about v1 (and the path to v2)

- **Storage** is JSON on disk with atomic writes — perfect for prototyping and
  tens of thousands of pages. When the index outgrows RAM: move `JsonStore`
  behind SQLite, then Postgres; the interfaces are already in place.
- **Payments** are not wired. `POST /v1/subscribe` activates in dev-mode so the
  whole flow works end to end. `src/api/billing.js` marks exactly where Stripe
  Checkout + webhook activation plug in.
- **HTML extraction** is regex-based: predictable and fast, replaceable by a
  real parser behind the same function in `src/crawler/extract.js`.
- **Crawl scale** is single-process. The queue/politeness logic is isolated in
  `src/crawler/crawler.js`, ready to shard by host when it's time.

What is *not* provisional: the ranking covenant in [INTEGRITY.md](INTEGRITY.md).
That part ships finished.
