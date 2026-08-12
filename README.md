# ✦ Northstar

**NOBODY CAN BUY THE SKY.**

A search engine built on one idea: **it answers to the person searching, and
to nobody else.** No ads. No sponsored results. No paid placement — there is
no code path for money to touch a ranking, and [a test enforces that](INTEGRITY.md).

**Northstar is free right now** — no tiers, no premium results, no locked
features. Everyone gets the same engine. The only limit is a high anti-abuse
fair-use ceiling. (If it is ever funded, it will be by a simple subscription
— never advertising, never selling placement or data. Results stay identical
for everyone either way.)

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
npm test         # 54 tests, including the ranking-integrity test
```

Open http://127.0.0.1:3000 and search for *pour over coffee*, *closures*, or
*ad-free search*. Click **Why this result ▸** under any hit.

## What the product does

- **Opens with a story.** First launch is a cinematic, skippable onboarding —
  "First Light" — told over a living starfield: what ad-funded search became,
  what Northstar promises instead, and the tagline moment. Along the way it
  asks (with the honest reason stated on screen, every time) for a first name
  (greeting only, stays on the device), an optional email (account — or
  "Continue without one," held open with equal dignity), and up to three
  curiosities that seed the first suggested searches. Replay it any time from
  the footer, or with `?story=1`.
- **Explains every result.** Each hit carries a `why` object — a plain-language
  summary plus the numeric factors behind the score. The full ranking formula
  is public API at `GET /v1/ranking`.
- **Tabs.** The web app is a small browser: multiple search tabs, each with its
  own query and results, restored (with cached results) when you come back.
- **History.** Searches are remembered server-side against your account, or an
  anonymous `ns_session` cookie — so *you* can find your way back. It is never
  used for ranking, never for ads (there are none), and one click clears it.
  **Private mode** (footer toggle, or `&private=1`) skips history entirely.
- **Customizable.** A Settings sheet lets you tune the engine to you: results
  per page, open links in a new tab, auto-expand every "why" receipt,
  suggestions on/off, save-history on/off (server-enforced), and a
  light/dark/system theme. Signed in, settings follow you across devices.
- **Installable.** A web app manifest, apple-touch-icon, safe-area layout and
  standalone meta make Northstar an add-to-home-screen app on iOS that runs
  full screen. `ios/` holds a SwiftUI `WKWebView` shell for the App Store path.
- **Fast.** Repeated queries answer from an in-memory LRU cache (`x-cache:
  hit`), invalidated automatically whenever the index changes; IDF is computed
  once per query; suggestions come from a cached frequency-sorted dictionary.
- **Free, no tiers.** Everyone gets the same engine. The only refusal is a
  fair-use ceiling (default 2000 searches/day, identical for all) that answers
  `429` purely to stop abuse — there is no paywall and no `402`.

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
                 │  /v1/ranking · /v1/history · /v1/settings│
                 │  accounts · API keys · sessions          │
                 └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────────┐
                 │        Web app (public/index.html)      │
                 │  monochrome · tabs · story onboarding · │
                 │  settings sheet · suggestions · PWA     │
                 └─────────────────────────────────────────┘
```

| Path | What it is |
| --- | --- |
| `src/core/tokenizer.js` | Normalization, light stemming, stopword handling |
| `src/core/index.js` | Inverted index, field hit tracking, PageRank + inlinks |
| `src/core/ranker.js` | Scoring, snippets, diversity, `why` receipts — the trust core |
| `src/crawler/` | robots.txt parser, HTML extraction, polite BFS crawler |
| `src/api/` | HTTP app, accounts/keys, settings, history, sessions |
| `public/index.html` | The Northstar web app (installable PWA) |
| `ios/` | SwiftUI `WKWebView` shell for the App Store path |
| `test/` | 54 tests, run with `npm test` |

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

# Create an account (returns an API key, shown once; binds this browser's
# session cookie with a fresh session id and migrates anonymous history in)
curl -X POST localhost:3000/v1/account \
  -H 'content-type: application/json' -d '{"email":"you@example.com","name":"Nova"}'

# Sign an existing account into a browser session (paste-your-key flow)
curl -X POST localhost:3000/v1/session/signin \
  -H 'content-type: application/json' -d '{"apiKey":"ns_…"}'

# Who is this browser signed in as? (always 200)
curl 'localhost:3000/v1/session'

# Customize the engine (account-scoped; behavior only, never ranking)
curl 'localhost:3000/v1/settings' -H 'Authorization: Bearer ns_…'
curl -X PUT 'localhost:3000/v1/settings' -H 'Authorization: Bearer ns_…' \
  -H 'content-type: application/json' -d '{"resultsPerPage":20,"theme":"dark","saveHistory":false}'

# Rename or delete your account (delete wipes keys, history, settings)
curl -X PUT    'localhost:3000/v1/account' -H 'Authorization: Bearer ns_…' \
  -H 'content-type: application/json' -d '{"name":"Nova"}'
curl -X DELETE 'localhost:3000/v1/account' -H 'Authorization: Bearer ns_…'
```

Also: `GET /v1/suggest?q=`, `GET /v1/plans`, `GET /v1/stats`, `GET /v1/account`,
`POST /v1/account/logout`, `GET /health`. Installable PWA assets:
`/manifest.webmanifest`, `/apple-touch-icon.png`, `/icon.svg`.

Security posture for browser sessions: the session id rotates whenever a
session gains an account (fixation defense), and cross-site requests are
treated as anonymous and never touch history or account quotas
(`Sec-Fetch-Site` guard on top of `SameSite=Lax`).

## Privacy stance

- History exists for you, keyed to your account or an anonymous first-party
  `ns_session` cookie (a random id, nothing else, httpOnly).
- Turn it off in Settings and the **server** treats every search as private —
  the switch is enforced, not cosmetic.
- It is deletable in one call, capped at 200 entries, expired after 90 days.
- Deleting your account erases keys, history, settings, and usage counters.
- Usage counters exist only to enforce the fair-use ceiling and are kept 7 days.
- Nothing is sold — there are no ads and no data business.

## What's honest about v1 (and the path to v2)

- **Storage** is JSON on disk with atomic writes — perfect for prototyping and
  tens of thousands of pages. When the index outgrows RAM: move `JsonStore`
  behind SQLite, then Postgres; the interfaces are already in place.
- **Free, no payments.** Northstar is free with a single fair-use ceiling.
  `src/api/billing.js` is the unplugged seam where a future subscription
  (Stripe Checkout + webhook activation) would attach — never advertising.
- **iOS** ships two ways: install the PWA today (Add to Home Screen), or build
  the SwiftUI shell in `ios/` in Xcode on a Mac (its sources aren't compiled
  here — see `ios/README.md`).
- **HTML extraction** is regex-based: predictable and fast, replaceable by a
  real parser behind the same function in `src/crawler/extract.js`.
- **Crawl scale** is single-process. The queue/politeness logic is isolated in
  `src/crawler/crawler.js`, ready to shard by host when it's time.

What is *not* provisional: the ranking covenant in [INTEGRITY.md](INTEGRITY.md).
That part ships finished.
