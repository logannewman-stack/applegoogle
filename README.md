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
npm test         # 76 tests, including the ranking-integrity test
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
- **Explains every result.** Each hit carries a `why` object — the star's own
  reasoning ("Your star chose this because…") as concrete, checkable items,
  plus the numeric factors. The full formula is public at `GET /v1/ranking`.
- **A real query language.** `"exact phrase"` requires the words together and
  in order, `-word` rules pages out, `site:example.org` stays on one host.
  Operators can only ever *narrow* — none of them can promote a page, and the
  star names every operator it obeyed.
- **Forgives typos.** A word the index has never seen is matched against the
  vocabulary by edit distance: it searches what you meant, says so, and leaves
  the literal search one tap away. Corrections never cross the first letter,
  so "bat" is never quietly turned into "cat".
- **Pages.** Results paginate with an honest position ("11–20 of 43 · page 2 of 5").
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
  "lead": "Your star chose this because",
  "reasons": [
    { "signal": "text_relevance",   "text": "It matches every word you searched for." },
    { "signal": "text_relevance",   "text": "“pour”, “over” and “coffee” sit in the page's own title, not buried in the body." },
    { "signal": "phrase_proximity", "text": "Your exact phrase “pour over” appears here, words together and in order." },
    { "signal": "link_authority",   "text": "2 other pages in the index chose to link here — authority it earned, not bought." },
    { "signal": "freshness",        "text": "It was crawled today, so what you’re reading is current." }
  ],
  "assurance": "Nothing was paid to put this here. Ranking cannot be bought.",
  "factors": { "textRelevance": 2.473, "linkAuthority": 1.35,
               "phraseProximity": 1.2, "freshness": 1.05 }
}
```

The reasoning stays honest in both directions: a page last crawled two years
ago is described as an older source, not as "current", and a page that matched
only some of your words says which ones are missing.

## Getting real results

Northstar owns its index — it does not proxy anyone else's. There are three
ways to fill it, and they compose.

### 1. Bootstrap a real index in one command

```bash
npm run bootstrap                 # crawl the curated starter sites
npm run bootstrap -- --pages=400  # go deeper
npm run bootstrap -- --topic=code
```

### 2. Live discovery — the index grows from what people ask

Turn it on and a query the index answers poorly sends Northstar out to read
the web:

```bash
WEB_DISCOVERY=1 npm start                          # Wikipedia, no API key needed
WEB_DISCOVERY=1 SEARCH_PROVIDER=brave BRAVE_API_KEY=… npm start
WEB_DISCOVERY=1 SEARCH_PROVIDER=google GOOGLE_API_KEY=… GOOGLE_CSE_ID=… npm start
WEB_DISCOVERY=1 SEARCH_PROVIDER=bing  BING_API_KEY=… npm start
```

Or expand on purpose:

```bash
curl -X POST localhost:3000/v1/discover -H 'content-type: application/json' -d '{"q":"tidal range"}'
```

**A provider only ever supplies candidate URLs.** Northstar fetches each page
itself (obeying `robots.txt` exactly as in any crawl), extracts it, indexes it,
recomputes authority, and ranks it with its own signals. The provider's
ordering is discarded — a test asserts that the page which actually matches
wins even when the provider listed another one first. That is what lets
Northstar reach the whole web without importing somebody else's ranking, and
it is why the covenant in [INTEGRITY.md](INTEGRITY.md) survives federation.
Every discovered page then explains itself like any other result.

### 3. Crawl exactly what you want

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
| `src/core/query.js` | Query language: phrases, exclusion, site filter, typo correction |
| `src/core/ranker.js` | Scoring, snippets, diversity, `why` receipts — the trust core |
| `src/websearch/` | Discovery providers (URLs only) + fetch-and-index expansion |
| `src/crawler/` | robots.txt parser, HTML extraction, polite BFS crawler |
| `src/api/` | HTTP app, accounts/keys, settings, history, sessions |
| `public/index.html` | The Northstar web app (installable PWA) |
| `ios/` | SwiftUI `WKWebView` shell for the App Store path |
| `test/` | 76 tests, run with `npm test` |

## API

```bash
# Search (the star's reasoning included on every result)
curl 'localhost:3000/v1/search?q=pour+over+coffee'

# Query operators
curl 'localhost:3000/v1/search?q="light pollution"'        # exact phrase
curl 'localhost:3000/v1/search?q=coffee+-espresso'          # rule a word out
curl 'localhost:3000/v1/search?q=site:sky.example.org+stars'

# Pages, and turning spelling correction off
curl 'localhost:3000/v1/search?q=stars&page=2&per_page=10'
curl 'localhost:3000/v1/search?q=polarus&literal=1'

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
