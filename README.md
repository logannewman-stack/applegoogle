# applegoogle

*(working name — swap in the real name and logo in `public/index.html` when they're ready)*

A search engine built on one idea: **if the searcher pays, the searcher is the
only customer.** No ads. No sponsored results. No paid placement — there is no
code path for money to touch a ranking, and [a test enforces that](INTEGRITY.md).
Revenue is subscriptions, so the engine makes money only by being useful.

The design target is "Google, if Apple designed it": monochrome, quiet, and
nothing on the page that isn't the answer.

## Quick start

Requires Node 22+. No dependencies to install — the entire backend is
standard-library Node.

```bash
npm run seed     # load sample documents so search works immediately
npm start        # http://127.0.0.1:3000
npm test         # 42 tests, including the ranking-integrity test
```

Open http://127.0.0.1:3000 and search for *pour over coffee*, *closures*, or
*ad-free search*.

## Crawl the real web

```bash
npm run crawl -- https://example.com --max-pages=50 --depth=2
```

The crawler is polite by construction: it obeys `robots.txt` (including
`Crawl-delay`), waits ≥1s between hits to the same host, sends an honest
User-Agent, honors `noindex` and `nofollow`, and bounds page size and time.
Behind an egress proxy, prefix with `NODE_USE_ENV_PROXY=1` so Node's fetch
uses `HTTPS_PROXY`.

## Architecture

```
                 ┌─────────────────────────────────────────┐
   seeds/ ─────► │             SearchIndex                 │
                 │  inverted index · positions · JSON on   │
   crawler ────► │  disk (atomic writes) · PageRank        │
   robots.txt    └──────────────────┬──────────────────────┘
   politeness                       │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │              Ranker                     │
                 │  BM25F (title 3×, desc 1.5×, body 1×)   │
                 │  × link authority × phrase proximity    │
                 │  × freshness — and nothing else, ever   │
                 └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │            HTTP API (node:http)         │
                 │  /v1/search · /v1/suggest · /v1/ranking │
                 │  accounts · API keys · subscriptions    │
                 └─────────────────────────────────────────┘
```

| Path | What it is |
| --- | --- |
| `src/core/tokenizer.js` | Normalization, light stemming, stopword handling |
| `src/core/index.js` | Inverted index, URL normalization, PageRank authority |
| `src/core/ranker.js` | Scoring, snippets, domain diversity — the trust core |
| `src/crawler/` | robots.txt parser, HTML extraction, polite BFS crawler |
| `src/api/` | HTTP app, accounts/keys, subscription plans |
| `public/index.html` | Minimal monochrome UI (placeholder branding) |
| `test/` | 42 tests, run with `npm test` |

## API

Anonymous search works out of the box (25/day per IP). Accounts raise the
limit; subscriptions effectively remove it.

```bash
# Search
curl 'localhost:3000/v1/search?q=pour+over+coffee'

# The public ranking formula — the trust feature
curl 'localhost:3000/v1/ranking'

# Create an account (returns an API key, shown once)
curl -X POST localhost:3000/v1/account \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'

# Authenticated search
curl 'localhost:3000/v1/search?q=coffee' -H 'Authorization: Bearer key_…'

# Subscribe (dev-mode activation until payments are wired in)
curl -X POST localhost:3000/v1/subscribe \
  -H 'Authorization: Bearer key_…' -H 'content-type: application/json' \
  -d '{"plan":"monthly"}'
```

Also: `GET /v1/suggest?q=`, `GET /v1/plans`, `GET /v1/stats`, `GET /v1/account`,
`POST /v1/subscribe/cancel`, `GET /health`.

When a free allowance runs out, the API answers `402` with a friendly
explanation and the upgrade path — that response *is* the business model.

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
