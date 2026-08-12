# Where Northstar runs

You need no database server. No Supabase, no Postgres, no Redis. The index is a
SQLite file that Node 22 can open on its own, and ranking is pure computation,
so Northstar needs exactly two things: a process, and somewhere to keep a file.

What it needs *somewhere to keep a file* for is the whole story. An engine that
has already read a few hundred thousand pages does not have to ask anyone
anything for most questions. Every page it keeps is a question it can answer
next time without going out to the web. **A deployment that forgets can never
get better at its job** — it re-fetches the same pages forever and stays as
good on its thousandth day as its first.

So there are three places to run this, and only two of them can learn.

| | **Fly / Render** | **Your machine** | **Vercel** |
|---|---|---|---|
| What it's for | The real public engine | Crawling, building an index | A front door only |
| Keeps what it learns | **Yes — a real disk** | Yes | **No — wiped on every cold start** |
| Index can grow to | Millions of pages | Millions | 43 seeds + this minute's crawl |
| Accounts & history | Kept | Kept | Minutes, not days |
| Cost | ~$0–7/month | Nothing | Nothing |
| Setup | [Below](#the-engine-that-remembers-fly-or-render) | [SETUP.md](SETUP.md) | [Below](#the-front-door-vercel) |

If you only do one thing, do Fly or Render. Vercel is a nice front door, but a
Northstar that forgets is a demo of a search engine rather than one.

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

---

## The engine that remembers: Fly or Render

Both files are already in the repo — `Dockerfile`, `fly.toml`, `render.yaml`.
Both mount a real disk at `/data` and point Northstar at it, which is the only
thing that actually matters here.

### Fly.io

```bash
# once
brew install flyctl        # or: curl -L https://fly.io/install.sh | sh
fly auth signup

# in the repo
fly launch --no-deploy --copy-config
fly volumes create northstar_data --size 3
fly deploy
```

`--copy-config` tells it to use the `fly.toml` in the repo rather than writing
a new one. The volume is the step people skip and then wonder why the index
keeps resetting — without it you have paid for a slower Vercel.

### Give it its own SearXNG

You can point it at public instances, but on a host you control there is a
better answer: run SearXNG next to Northstar as a second Fly app, reachable
only from the first. No volunteers, no shared rate limit, no third party
seeing a single query — and nothing extra to pay, because it needs no volume.

```bash
mkdir -p ../northstar-searxng && cd ../northstar-searxng
fly launch --no-deploy --image searxng/searxng:latest --name northstar-searxng
```

In the `fly.toml` it writes, make it private and turn on the two settings a
stock SearXNG has the wrong way round for a program:

```toml
[env]
  SEARXNG_BASE_URL = "http://northstar-searxng.flycast/"
  SEARXNG_SETTINGS_PATH = "/etc/searxng/settings.yml"

[http_service]
  internal_port = 8080
  # No public address: only apps inside your Fly network can reach it.
  auto_stop_machines = true
  auto_start_machines = true
```

Copy this repo's `searxng/settings.yml` into that app (it is the file that
enables the JSON API and disables the bot limiter), then `fly deploy`.

Back in the Northstar app, point at it over Fly's private network:

```bash
cd -
fly secrets set SEARXNG_URL="http://northstar-searxng.flycast:8080"
```

`.flycast` addresses are internal — that instance has no public URL at all.

**Or, without the second app:** public instances, comma-separated.
`npm run find-searxng` prints a list that works.

```bash
fly secrets set SEARXNG_URL="https://a.example,https://b.example"
```

Check it: `fly open /health` → `{"documents":43,"storage":"persistent"}`.
**`"persistent"` is the word that matters** — it means the disk is mounted and
what it learns will still be there tomorrow.

### Render

Push, then in the dashboard: **New → Blueprint → pick the repo**. It reads
`render.yaml`, provisions the disk and deploys. Add `SEARXNG_URL` under
**Environment**.

One caveat worth knowing before you start: a disk cannot be attached to
Render's free plan, so `render.yaml` asks for Starter (~$7/month). Fly's free
allowance does include a small volume, which is why it is listed first.

### Then build it an index

This is the part that makes it worth having a disk:

```bash
fly ssh console -C "npm run bootstrap -- --pages=400"
```

Every page it reads is one it never has to fetch again. Run it whenever you
want the engine to know more; the index grows and stays.

## The front door: Vercel

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

**Option A — whole web, no account, no card** (recommended)

SearXNG is open-source metasearch run by volunteers. There is no signup and
nothing to pay. The catch is that any *single* public instance is unreliable —
operators switch the JSON API off, rate limiters trip, hosts go down — so
Northstar takes a **list** and tries them in order until one answers. A list of
five is dependable even though no single member of it is.

Find instances that actually work, from your own machine:

```bash
npm run find-searxng
```

It asks each one a real question, keeps the ones that answer, and prints a
ready-to-paste line. Then add:

| Name | Value |
|---|---|
| `SEARCH_PROVIDER` | `searxng` |
| `SEARXNG_URL` | `https://a.example,https://b.example,https://c.example` |

Comma-separated, no spaces needed.

> **One honest caveat.** `find-searxng` probes from your laptop. Vercel calls
> from a datacenter IP, and some instances block those even when they answer
> you fine at home. If searches on the deployment come back thin while the same
> list works locally, that is what happened — put more instances in the list,
> or use Option B.

**Option B — whole web, needs a free account**

Get a key at [brave.com/search/api](https://brave.com/search/api/) (free tier,
2,000 queries/month, but it asks for a card to activate), then add:

| Name | Value |
|---|---|
| `SEARCH_PROVIDER` | `brave` |
| `BRAVE_API_KEY` | *your key* |

**Either way, it never goes dark.** If the chosen provider cannot answer at
all, Northstar falls back to Wikipedia rather than telling someone their
question has no answer — and says so in the logs. Set
`SEARCH_FALLBACK_PROVIDER` to an empty string if you would rather it failed
loudly.

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
discovery gives up after 9 by design (2.5 when you run it locally, where there
is already an index to fall back on). If you see this repeatedly your provider
is unreachable from Vercel — check the key, or switch providers.

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
