# Where Northstar runs

You need no database. No Supabase, no Postgres, no Redis. Northstar's index is
a JSON file and its ranking is pure computation, so the only two things it ever
needs are a Node process and an outbound network connection.

That gives you exactly two places to run it, and they are for different jobs.

| | **Your own machine** | **Vercel** |
|---|---|---|
| What it's for | Using it, crawling, building an index | A public URL people can open |
| Keeps what it learns | Yes — `data/index.json` grows | No — wiped on every cold start |
| Accounts & history | Kept | Last minutes, not days |
| Whole-web search | Yes, SearXNG in Docker | Wikipedia free; whole web needs a key |
| Cost | Nothing | Nothing (Hobby) |
| Setup | [SETUP.md](SETUP.md) | This file, ~10 minutes |

**Do both.** Your machine is the real engine. Vercel is the front door.

---

## Why there is no database

A search engine looks like it needs one. Northstar doesn't, because of how it
is built:

- **The index is one JSON file.** 43 seed pages, or 10,000 crawled ones — it
  loads into memory at boot and is written back atomically. Postgres would be
  storing a blob it cannot help you query.
- **Ranking is computed, never stored.** BM25F, link authority, phrase
  proximity and freshness are recalculated per query from the index in memory.
  There is nothing to persist.
- **A serverless instance can rebuild from nothing.** Cold start reads
  `seeds/` into memory in well under a second, and every query it cannot
  answer well goes and reads the live web.

So the Vercel deployment is not a crippled version. It is a Northstar that
forgets — which for a public demo is arguably the more honest posture.

---

## The to-do list

Everything below is done once. Roughly ten minutes.

### 1. Make sure GitHub has the current code

```bash
git push -u origin main
```

Vercel deploys from GitHub, so anything not pushed does not exist as far as it
is concerned.

### 2. Import the repo into Vercel

1. Go to **[vercel.com/new](https://vercel.com/new)**.
2. If this is your first time, click **Continue with GitHub** and authorise it.
3. Find **`applegoogle`** in the repository list and click **Import**.
   (Don't see it? Click *Adjust GitHub App Permissions* and grant access to
   the repo.)

### 3. Leave every build setting alone

Vercel will show a **Configure Project** screen. The correct answer to all of
it is *don't touch it*:

| Field | What it should say | Why |
|---|---|---|
| Framework Preset | **Other** | Northstar is not a framework app |
| Build Command | *empty* | Nothing to build — zero dependencies |
| Output Directory | `public` | The static shell lives there |
| Install Command | *default* | There is nothing to install |
| Root Directory | `./` | |

The repo already contains `vercel.json`, which tells Vercel the two things it
cannot guess: run `api/index.js` as the function, and send anything that isn't
a static file to it.

### 4. Click Deploy

Wait about 40 seconds. You will get a URL like
`https://applegoogle-xxxx.vercel.app`.

### 5. Check it came up correctly

Open these three, in order:

**`https://your-url.vercel.app/health`**

```json
{ "ok": true, "documents": 43, "storage": "ephemeral" }
```

`documents: 43` is the important part — it means the instance built the corpus
on cold start. If it says `0`, the `seeds/` folder didn't ship; see
[troubleshooting](#if-something-is-wrong).

**`https://your-url.vercel.app/v1/stats`**

```json
{ "discovery": { "enabled": true, "provider": "wikipedia" },
  "storage": { "durable": false } }
```

**`https://your-url.vercel.app`** — the app itself. The story plays, then
search. Try `pour over coffee` (a seeded page) and then `photosynthesis`
(nothing local — it must go to the web). Both should show
**Your star chose this because** under every result.

### 6. Set the Node version, if it complains

Only if the deploy fails with a Node version error: **Project → Settings →
General → Node.js Version → 22.x**, then **Deployments → ⋯ → Redeploy**.

### 7. Decide how much of the web it can see

Out of the box the deployment searches **Wikipedia** — keyless, instant, and
genuinely useful, but encyclopedia articles only. Two ways to widen it, both
in **Project → Settings → Environment Variables**:

**Option A — whole web, needs a free account** (recommended)

Get a key at [brave.com/search/api](https://brave.com/search/api/) (free tier,
2,000 queries/month), then add:

| Name | Value |
|---|---|
| `SEARCH_PROVIDER` | `brave` |
| `BRAVE_API_KEY` | *your key* |

**Option B — whole web, no account, less reliable**

Point at a public SearXNG instance from
[searx.space](https://searx.space) that has the JSON API enabled:

| Name | Value |
|---|---|
| `SEARCH_PROVIDER` | `searxng` |
| `SEARXNG_URL` | `https://searx.example.org` |

Public instances rate-limit strangers, so expect occasional empty expansions.

**Redeploy after adding variables** — environment variables are read at boot,
so existing instances won't see them. **Deployments → ⋯ → Redeploy**.

### 8. Every push now deploys itself

Vercel watches `main`. Commit, push, and the site updates. Nothing else to
wire up.

---

## What you are giving up, precisely

The Vercel deployment **forgets everything between cold starts**:

- Pages it crawled for someone's query — gone, re-fetched next time.
- Accounts someone created — gone. The name in the story won't be there
  tomorrow.
- Search history — gone.
- The index never grows past the 43 seeded pages plus whatever the current
  instance has read in the last few minutes.

Nothing about this is broken; it is what a read-only filesystem and a
disposable `/tmp` mean. Northstar detects the host (`VERCEL=1`), switches its
data directory to `/tmp`, seeds itself on boot, turns web discovery on, and
reports `"storage": "ephemeral"` through the API rather than pretending.

**To have a Northstar that remembers, run it on your own machine**
([SETUP.md](SETUP.md)) — `npm run bootstrap` builds a real index that is yours
and keeps growing. The Vercel URL is the shop window; your machine is the
workshop.

When you eventually want a public Northstar with a memory, the change is
small and does not need Supabase: swap `JsonStore` for the same JSON in a
blob store, or move to a host with a persistent disk. One file,
`src/storage/store.js`, is the whole surface.

> One note on Vercel's terms: the Hobby plan is for non-commercial projects.
> The day Northstar takes money, that plan is the wrong one.

---

## If something is wrong

### `/health` says `documents: 0`
The bundled corpus didn't ship. Confirm `vercel.json` at the repo root
contains `"includeFiles": "{public,seeds}/**"`, and that `seeds/` is committed
(`git ls-files seeds/` should list two JSON files). Push and redeploy.

### The page loads but every search returns nothing
Open `/v1/stats`. If `discovery.enabled` is `false`, something set
`WEB_DISCOVERY=0` — remove that environment variable and redeploy. If it is
`true` but searches still come back empty, the provider is failing: switch to
`wikipedia` (no key) to isolate whether it's your key or your provider.

### 404 on every route
`vercel.json` didn't ship or was edited. It needs the catch-all rewrite:
```json
"rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
```

### `FUNCTION_INVOCATION_TIMEOUT`
A slow provider held the request open. `vercel.json` allows 60 seconds, and
discovery gives up after 2.5 by design. If you see this repeatedly your
provider is unreachable from Vercel — check the key, or switch providers.

### Deploy fails on install
There are no dependencies to install. If npm is erroring, something added a
`package-lock.json` that doesn't belong — delete it and push.

### It works locally but not deployed
The difference is almost always an environment variable. Locally you have
`.env.local`; Vercel has none of it, by design — `.env*` is gitignored so keys
never reach GitHub. Anything in `.env.local` that matters must be re-entered
in **Settings → Environment Variables**.

---

## Local and deployed, side by side

```bash
# your machine — the engine that remembers
npm run seed && npm start          # http://127.0.0.1:3000
npm run bootstrap                  # grow a real index
npm run doctor                     # diagnose

# the deployment — the front door
git push                           # that's the whole deploy step
```
