# Setting up Northstar

From nothing to a working search engine that can answer anything, and shows
its reasoning on every result. About ten minutes, no API key, no account.

Each step says what you should see. If a step prints something else, jump to
[When something goes wrong](#when-something-goes-wrong).

---

## Step 0 — What you need

**Node 22 or newer.** Check:

```bash
node --version
```

You should see `v22.x` or higher. If not, install it from
[nodejs.org](https://nodejs.org) (or `brew install node` on a Mac).

**Docker** — only for Step 3, and only if you want Northstar to search the
whole web. Skip it if you just want to see it running. Get it from
[docker.com](https://www.docker.com/products/docker-desktop/).

---

## Step 1 — Get the code

```bash
git clone https://github.com/logannewman-stack/applegoogle.git northstar
cd northstar
```

There is nothing to `npm install`. Northstar has zero dependencies — the
entire engine is standard-library Node.

**You should see:** a `northstar` folder containing `src/`, `public/`, `seeds/`.

---

## Step 2 — Run it with the sample index

```bash
npm run seed
npm start
```

**You should see:**

```
seeded 43 documents (43 total in index, 1363 terms)
search engine listening on http://127.0.0.1:3000
```

Open **http://127.0.0.1:3000** in your browser. The story plays on the first
visit — swipe or scroll through it, or click the Northstar wordmark in the
corner to go straight to search.

Try searching `pour over coffee`. You should get results, each one showing
**Your star chose this because** with its reasons underneath.

At this point Northstar only knows the 43 sample pages. Step 3 gives it the
whole web.

> Stop the server any time with **Ctrl-C**.

---

## Step 3 — Let it search the whole web

Northstar needs a way to *find out which pages exist*. It then reads and ranks
those pages itself. The easiest source is SearXNG, an open-source search
aggregator you run on your own machine — no key, no account, nobody else
seeing your queries.

**3a. Start SearXNG** (leave Docker running):

```bash
docker run -d --name searxng -p 8888:8080 \
  -e SEARXNG_SETTINGS__SEARCH__FORMATS='["html","json"]' \
  searxng/searxng
```

**You should see:** a long container ID. Confirm it is up:

```bash
curl -s "http://localhost:8888/search?q=test&format=json" | head -c 100
```

**You should see:** JSON starting with `{"query": "test"...`.
If you get an error, see [troubleshooting](#searxng-wont-answer).

**3b. Point Northstar at it:**

```bash
npm run setup:web -- --provider=searxng --url=http://localhost:8888
```

**You should see:**

```
✓ wrote .env.local (searxng)
asking SearXNG (open metasearch, no key) for candidate URLs for "polaris navigation" …
✓ it named 4 URLs, e.g. https://en.wikipedia.org/wiki/Polaris
fetching and indexing one of them, the way a real search would …
✓ indexed 2 page(s) — e.g. Polaris - Wikipedia

Northstar can search the web.
```

That last line means the whole path works: it asked for addresses, fetched
real pages, and indexed them.

**3c. Start it again:**

```bash
npm start
```

Now search for anything — `how to fix a leaky faucet`, `who won the 1998 world
cup`, whatever. When Northstar's index cannot answer well, it goes and reads
the web, then ranks what it found with its own signals. You will see:

> *Northstar went and read 5 new pages from the web for this, then ranked them itself.*

---

## Step 4 — Give it a foundation of its own (recommended)

Every page Northstar has already read costs nothing to search again. Build a
real index of your own so it depends less on the aggregator over time:

```bash
npm run bootstrap
```

**You should see:** pages being indexed one per line, then a summary like
`indexed 118 new pages … index: 43 → 161 documents`.

Run it again with `-- --pages=400` any time you want more.

---

## Step 5 — Check everything is healthy

```bash
npm run doctor
```

**You should see** a list of ✓ checks and, at the end, `Everything checks out.`
Any ✗ comes with the exact command to fix it.

---

## That is the whole setup

```bash
npm start          # run it
npm run doctor     # diagnose anything odd
npm run bootstrap  # index more of the web
npm test           # 125 tests, including the one that proves ranking can't be bought
```

Want a public URL other people can open? **[DEPLOY.md](DEPLOY.md)** puts it on
Vercel in about ten minutes — no database, no second account.

---

## Every result shows its reasoning

This is on by default and needs no configuration. Under each result you will
see the star's own account of why that source is there:

> **Your star chose this because**
> ◆ It matches every word you searched for.
> ◆ "tidal" and "range" sit in the page's own title, not buried in the body.
> ◆ It gets to your answer in the opening lines, not halfway down the page.
> ◆ 2 other pages in the index chose to link here — authority it earned, not bought.
> ◆ It was crawled today, so what you're reading is current.
>
> *Nothing was paid to put this here. Ranking cannot be bought.*

The reasoning is held to the same standard as the results:

- **Truthful** — it never flatters a page. A source last crawled two years ago
  is described as an older source, not as "current". A page that matched only
  some of your words says which ones it missed. A page that surfaced on weak
  signals says so and tells you to treat it with suspicion.
- **Helpful** — every line is something you could check yourself: the words are
  in the title, the exact phrase is present, the answer is near the top, other
  pages link here.
- **Relatable** — plain sentences, not scores. The numbers are there underneath
  for anyone who wants them.

Prefer it collapsed? Settings (the gear, top right) → Search → *Always show
reasoning*. It stays available on every result either way.

---

## When something goes wrong

### `node: command not found` or a version below 22
Install Node 22+ from [nodejs.org](https://nodejs.org). On a Mac with Homebrew:
`brew install node`.

### Port 3000 is already in use
```bash
PORT=3100 npm start
```
Then open http://127.0.0.1:3100.

### SearXNG won't answer
Check the container is running:
```bash
docker ps --filter name=searxng
```
Nothing listed? Start it again with the command in Step 3a.

If it is running but `format=json` returns an error, the JSON API is switched
off. Recreate it with the format enabled:
```bash
docker rm -f searxng
docker run -d --name searxng -p 8888:8080 \
  -e SEARXNG_SETTINGS__SEARCH__FORMATS='["html","json"]' searxng/searxng
```

### Searches never reach the web
Run `npm run doctor`. It checks, in order: the index, outbound HTTPS, your
provider configuration, a live round trip, and robots.txt handling — and
prints the fix for whatever failed.

Most common cause: `.env.local` is missing or `WEB_DISCOVERY=0`. Re-run
Step 3b.

### Behind a company proxy or VPN
Prefix commands so Node uses the proxy:
```bash
NODE_USE_ENV_PROXY=1 npm start
NODE_USE_ENV_PROXY=1 npm run doctor
```

### Results are thin for an unusual question
Click **Look further** underneath the results. That sends Northstar out to read
the web for that exact query, ignoring the usual cooldown.

### You want to start over
```bash
rm -rf data          # forget the index, accounts and history
npm run seed
```

---

## Prefer not to run Docker?

Three alternatives, all fine:

**Public SearXNG instances** — whole web, no key, no Docker, no account. Any
single public instance is a coin flip, so use several and let Northstar fall
through them:
```bash
npm run find-searxng      # probes real instances, prints the ones that work
npm run setup:web -- --provider=searxng --url="https://a.example,https://b.example"
```

**Wikipedia** — no key, no Docker, nothing to configure, but encyclopedia
articles only:
```bash
npm run setup:web -- --provider=wikipedia
```

**Brave Search API** — hosted, whole-web, free tier; needs an account at
[brave.com/search/api](https://brave.com/search/api/), and it asks for a card
to activate:
```bash
npm run setup:web -- --provider=brave --key=YOUR_KEY
```

Whichever you choose, the rule does not change: the provider only ever hands
Northstar a list of addresses. Northstar fetches, indexes and ranks every page
itself, so nobody else's ranking — and nobody's money — decides what you see.
