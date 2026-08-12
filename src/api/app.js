// HTTP app assembly. Plain node:http, no framework.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { makeConfig } from '../config.js';
import { JsonStore } from '../storage/store.js';
import { SearchIndex, emptyIndexData } from '../core/index.js';
import { search, RANKING_SIGNALS, EXCLUDED_FOREVER } from '../core/ranker.js';
import { stem } from '../core/tokenizer.js';
import {
  emptyUsersData, emptyUsageData, createAccount, resolveActor, chargeSearch, usedToday,
  linkSession, unlinkSession, userForSession, extractApiKey, findUserByKey, cleanName,
} from './auth.js';
import { settingsFor, applySettings, historyEnabled, DEFAULT_SETTINGS } from './settings.js';
import {
  emptyHistoryData, recordSearch, listHistory, clearHistory, removeHistoryEntry, migrateHistory,
} from './history.js';
import { Discovery } from '../websearch/discovery.js';
import { PROVIDERS } from '../websearch/providers.js';

const INDEX_HTML_PATH = new URL('../../public/index.html', import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'ns_session';
const QUERY_CACHE_MAX = 200;

// PWA assets served from public/, path-whitelisted.
const STATIC_FILES = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...extraHeaders,
  });
  res.end(payload);
}

function parseCookies(req) {
  const jar = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return jar;
}

// Anonymous session id from the ns_session cookie, minting one if absent.
// The cookie exists so *your* history follows you — it is httpOnly, first-
// party, and carries a random id, nothing else.
function resolveSession(req) {
  const existing = parseCookies(req)[SESSION_COOKIE];
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return { id: existing, isNew: false };
  return { id: randomUUID(), isNew: true };
}

function sessionCookieHeader(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  sendJson(res, status, {
    error: {
      code: err.code || 'internal_error',
      message: status >= 500 && !err.code ? 'Something went wrong on our side.' : err.message,
      ...(err.upgrade ? { upgrade: err.upgrade } : {}),
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413, code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body must be valid JSON.'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export async function createApp(overrides = {}) {
  const config = makeConfig(overrides);

  const indexStore = await new JsonStore(config.dataDir, 'index', emptyIndexData()).load();
  const usersStore = await new JsonStore(config.dataDir, 'users', emptyUsersData()).load();
  const usageStore = await new JsonStore(config.dataDir, 'usage', emptyUsageData()).load();
  const historyStore = await new JsonStore(config.dataDir, 'history', emptyHistoryData()).load();
  const index = new SearchIndex(indexStore);
  const discovery = new Discovery(index, config, {
    fetchImpl: overrides.fetchImpl || fetch,
    log: (m) => console.log(`[discovery] ${m}`),
  });
  const startedAt = Date.now();

  // Result cache: repeated queries answer from memory. Keys embed the index's
  // updatedAt stamp, so any index change invalidates the whole cache at once.
  const queryCache = new Map();
  function cachedSearch(q, page, perPage, allowCorrection = true) {
    const key = `${index.data.updatedAt}|${page}|${perPage}|${allowCorrection ? 'c' : 'l'}|${q}`;
    if (queryCache.has(key)) {
      const hit = queryCache.get(key);
      queryCache.delete(key);
      queryCache.set(key, hit); // LRU refresh
      return { body: hit, cacheStatus: 'hit' };
    }
    const body = search(index, q, { page, perPage, allowCorrection });
    queryCache.set(key, body);
    if (queryCache.size > QUERY_CACHE_MAX) {
      queryCache.delete(queryCache.keys().next().value);
    }
    return { body, cacheStatus: 'miss' };
  }

  // Owner key for history: the account if authenticated, else the session.
  function historyOwner(actor, session) {
    return actor.user ? `user:${actor.user.id}` : `sess:${session.id}`;
  }

  // Term dictionary for /v1/suggest, sorted by document frequency, rebuilt
  // lazily whenever the index changes.
  let termDict = { stamp: undefined, terms: [] };
  function getTermDict() {
    if (termDict.stamp !== index.data.updatedAt) {
      const terms = [];
      for (const term in index.data.postings) {
        const df = index.documentFrequency(term);
        if (df > 0) terms.push({ term, display: index.data.postings[term].display, df });
      }
      terms.sort((a, b) => b.df - a.df);
      termDict = { stamp: index.data.updatedAt, terms };
    }
    return termDict.terms;
  }

  const handlers = {
    'GET /health': async (_req, res) => {
      sendJson(res, 200, { ok: true, documents: index.docCount, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
    },

    'GET /v1/search': async (req, res, url) => {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        throw Object.assign(new Error("Missing query. Use /v1/search?q=<terms>."), { status: 400, code: 'missing_query' });
      }
      if (q.length > 500) {
        throw Object.assign(new Error('Query too long (max 500 characters).'), { status: 400, code: 'query_too_long' });
      }
      // A cross-site GET carries the session cookie under SameSite=Lax, so a
      // hostile page could otherwise spend a victim's quota or plant history.
      // Cross-site requests run as anonymous and never touch history.
      const crossSite = (req.headers['sec-fetch-site'] || '') === 'cross-site';
      const session = resolveSession(req);
      const actor = resolveActor(req, url, usersStore.data, config, crossSite ? null : session.id);
      const settings = settingsFor(actor.user);

      const page = Math.max(1, Math.min(100, Number(url.searchParams.get('page')) || 1));
      const perPage = Math.max(1, Math.min(50, Number(url.searchParams.get('per_page')) || settings.resultsPerPage));
      // A search is private if the caller says so — or if the account's
      // settings say history should never be kept. The server enforces it.
      const isPrivate = url.searchParams.get('private') === '1' || !settings.saveHistory;

      // literal=1 turns off spelling correction: "no, I meant exactly this".
      const literal = url.searchParams.get('literal') === '1';

      const usage = chargeSearch(usageStore.data, actor);
      usageStore.scheduleSave();

      let { body, cacheStatus } = cachedSearch(q, page, perPage, !literal);

      // Thin result set? Go and find more of the web, then answer from the
      // enlarged index. The provider named URLs; the ranking below is ours.
      let expanded = null;
      if (discovery.enabled && page === 1 && body.total < config.discoveryMinResults
          && !discovery.isCoolingDown(q)) {
        try {
          const result = await discovery.expand(q);
          if (result.added > 0) {
            index.computeAuthority();
            indexStore.scheduleSave();
            queryCache.clear();
            ({ body, cacheStatus } = cachedSearch(q, page, perPage, !literal));
            expanded = { added: result.added, provider: result.provider };
          }
        } catch (err) {
          console.warn('[discovery]', err.message);
        }
      }

      if (!isPrivate && !crossSite) {
        recordSearch(historyStore.data, historyOwner(actor, session), q, body.total);
        historyStore.scheduleSave();
      }

      const headers = { 'x-cache': cacheStatus };
      if (session.isNew) headers['set-cookie'] = sessionCookieHeader(session.id);
      sendJson(res, 200, {
        ...body,
        cached: cacheStatus === 'hit',
        private: isPrivate,
        expanded,
        plan: actor.plan,
        usageToday: usage,
      }, headers);
    },

    // Your history: inspectable and deletable. Never used for ranking or ads.
    'GET /v1/history': async (req, res, url) => {
      const session = resolveSession(req);
      const actor = resolveActor(req, url, usersStore.data, config, session.id);
      const limit = Number(url.searchParams.get('limit')) || 20;
      const headers = session.isNew ? { 'set-cookie': sessionCookieHeader(session.id) } : {};
      sendJson(res, 200, {
        history: listHistory(historyStore.data, historyOwner(actor, session), limit),
        note: 'History is stored so you can find your way back. Delete it any time with DELETE /v1/history.',
      }, headers);
    },

    'DELETE /v1/history': async (req, res, url) => {
      const session = resolveSession(req);
      const actor = resolveActor(req, url, usersStore.data, config, session.id);
      const owner = historyOwner(actor, session);
      const query = url.searchParams.get('query');
      const removed = query
        ? removeHistoryEntry(historyStore.data, owner, query)
        : clearHistory(historyStore.data, owner);
      historyStore.scheduleSave();
      sendJson(res, 200, { removed, remaining: listHistory(historyStore.data, owner, 5).length });
    },

    'GET /v1/suggest': async (_req, res, url) => {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return sendJson(res, 200, { suggestions: [] });
      const prefix = stem(q.split(/\s+/).pop());
      const seen = new Set();
      const suggestions = [];
      for (const entry of getTermDict()) {
        if (!entry.term.startsWith(prefix) || seen.has(entry.display)) continue;
        seen.add(entry.display);
        suggestions.push(entry.display);
        if (suggestions.length >= 8) break;
      }
      sendJson(res, 200, { suggestions });
    },

    // The ranking formula is public. Anyone can audit what decides results —
    // and what is permanently excluded from deciding them.
    'GET /v1/ranking': async (_req, res) => {
      sendJson(res, 200, {
        promise: 'Results are ranked by relevance to your query. Ranking cannot be bought.',
        signals: RANKING_SIGNALS,
        neverConsidered: EXCLUDED_FOREVER,
        enforcement: 'test/ranker.test.js verifies that sponsorship-style fields injected into documents cannot change any score.',
      });
    },

    'GET /v1/plans': async (_req, res) => {
      sendJson(res, 200, {
        pricing: 'free',
        message: 'Northstar is free right now. No tiers, no premium results, no locked features — everyone gets the same engine.',
        fairUse: `The only limit is a fair-use ceiling of ${config.dailyFairUseCeiling} searches per day, identical for everyone, to stop abuse.`,
        future: 'When Northstar matures it will be funded by a simple subscription — never by advertising, never by selling placement or data.',
        principles: [
          'No advertising. No sponsored results. No paid ranking — there is no mechanism for it.',
          'Free means free: no tiers, and your data is not the price.',
          'If subscriptions arrive one day, results stay identical for everyone either way.',
        ],
      });
    },

    'GET /v1/stats': async (_req, res) => {
      sendJson(res, 200, {
        documents: index.docCount,
        terms: index.termCount,
        updatedAt: index.data.updatedAt,
        discovery: {
          enabled: discovery.enabled,
          provider: config.searchProvider,
          providers: Object.keys(PROVIDERS),
        },
      });
    },

    // Reach past the local index on purpose: name a query, get real pages
    // fetched, indexed and ranked by Northstar's own signals.
    'POST /v1/discover': async (req, res, url) => {
      const body = await readBody(req);
      const q = String(body.q || url.searchParams.get('q') || '').trim();
      if (!q) {
        throw Object.assign(new Error('Give me something to look for: {"q": "…"}.'), { status: 400, code: 'missing_query' });
      }
      const result = await discovery.expand(q, { force: body.force === true });
      if (result.added > 0) {
        index.computeAuthority();
        indexStore.scheduleSave();
        queryCache.clear();
      }
      sendJson(res, 200, {
        ...result,
        documents: index.docCount,
        note: 'The provider supplied candidate addresses only. Northstar fetched, indexed and ranked these pages itself.',
      });
    },

    'POST /v1/account': async (req, res) => {
      const body = await readBody(req);
      const { user, apiKey } = createAccount(usersStore.data, body.email, body.name);

      // Sign this browser in with a FRESH session id (rotating at the
      // privilege boundary defeats session fixation), and carry any
      // anonymous history from the old session into the account.
      const oldSession = resolveSession(req);
      const newSessionId = randomUUID();
      migrateHistory(historyStore.data, `sess:${oldSession.id}`, `user:${user.id}`);
      unlinkSession(usersStore.data, oldSession.id);
      linkSession(usersStore.data, newSessionId, user.id);
      usersStore.scheduleSave();
      historyStore.scheduleSave();

      sendJson(res, 201, {
        account: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
        apiKey,
        signedIn: true,
        note: 'Store this API key now — it is shown only once and kept only as a hash.',
      }, { 'set-cookie': sessionCookieHeader(newSessionId) });
    },

    // Sign an existing account into this browser: paste the API key once,
    // the session cookie carries it from then on. Session id rotates here
    // for the same fixation-defense reason as account creation.
    'POST /v1/session/signin': async (req, res, url) => {
      const body = await readBody(req);
      const apiKey = extractApiKey(req, url) || body.apiKey;
      const user = findUserByKey(usersStore.data, apiKey);
      if (!user) {
        throw Object.assign(new Error('That key didn’t match any account.'), { status: 401, code: 'invalid_key' });
      }
      const oldSession = resolveSession(req);
      const newSessionId = randomUUID();
      // Only carry anonymous history in if this account actually keeps
      // history — migrating into a saveHistory:false account would violate it.
      if (historyEnabled(user)) {
        migrateHistory(historyStore.data, `sess:${oldSession.id}`, `user:${user.id}`);
      } else {
        clearHistory(historyStore.data, `sess:${oldSession.id}`);
      }
      unlinkSession(usersStore.data, oldSession.id);
      linkSession(usersStore.data, newSessionId, user.id);
      usersStore.scheduleSave();
      historyStore.scheduleSave();
      sendJson(res, 200, {
        signedIn: true,
        account: { email: user.email, name: user.name ?? null },
      }, { 'set-cookie': sessionCookieHeader(newSessionId) });
    },

    'GET /v1/account': async (req, res, url) => {
      const actor = requireUser(req, url);
      sendJson(res, 200, {
        account: {
          id: actor.user.id,
          email: actor.user.email,
          name: actor.user.name ?? null,
          createdAt: actor.user.createdAt,
        },
        usageToday: { used: usedToday(usageStore.data, actor.id), limit: actor.dailyLimit },
      });
    },

    // Update the account's display name.
    'PUT /v1/account': async (req, res, url) => {
      const actor = requireUser(req, url);
      const body = await readBody(req);
      actor.user.name = cleanName(body.name);
      usersStore.scheduleSave();
      sendJson(res, 200, { account: { email: actor.user.email, name: actor.user.name } });
    },

    // Delete the account and everything attached to it: keys, session
    // bindings, history, usage counters. "Your data" means deletable.
    'DELETE /v1/account': async (req, res, url) => {
      const actor = requireUser(req, url);
      const userId = actor.user.id;
      const users = usersStore.data;

      delete users.byEmail[actor.user.email];
      for (const [hash, id] of Object.entries(users.byKeyHash)) {
        if (id === userId) delete users.byKeyHash[hash];
      }
      for (const [sess, id] of Object.entries(users.sessionLinks || {})) {
        if (id === userId) delete users.sessionLinks[sess];
      }
      delete users.users[userId];
      clearHistory(historyStore.data, `user:${userId}`);
      for (const day of Object.values(usageStore.data.days)) delete day[`user:${userId}`];

      usersStore.scheduleSave();
      historyStore.scheduleSave();
      usageStore.scheduleSave();
      sendJson(res, 200, { deleted: true, note: 'Account, API keys, history, and usage counters are gone. Thank you for sailing with us.' });
    },

    // Search settings — behavior only, never ranking (see INTEGRITY.md).
    'GET /v1/settings': async (req, res, url) => {
      const session = resolveSession(req);
      const actor = resolveActor(req, url, usersStore.data, config, session.id);
      sendJson(res, 200, {
        settings: settingsFor(actor.user),
        stored: actor.user ? 'account' : 'defaults',
        available: Object.keys(DEFAULT_SETTINGS),
      });
    },

    'PUT /v1/settings': async (req, res, url) => {
      const actor = requireUser(req, url);
      const body = await readBody(req);
      const settings = applySettings(actor.user, body);
      usersStore.scheduleSave();
      sendJson(res, 200, { settings, stored: 'account' });
    },

    // Who is this browser signed in as? Always 200, so the web app can ask
    // politely without generating 401 noise on every load.
    'GET /v1/session': async (req, res) => {
      const session = resolveSession(req);
      const user = userForSession(usersStore.data, session.id);
      const headers = session.isNew ? { 'set-cookie': sessionCookieHeader(session.id) } : {};
      sendJson(res, 200, user
        ? { signedIn: true, account: { email: user.email, name: user.name ?? null } }
        : { signedIn: false }, headers);
    },

    'POST /v1/account/logout': async (req, res) => {
      const session = resolveSession(req);
      unlinkSession(usersStore.data, session.id);
      usersStore.scheduleSave();
      sendJson(res, 200, { signedOut: true });
    },

  };

  function requireUser(req, url) {
    const session = resolveSession(req);
    const actor = resolveActor(req, url, usersStore.data, config, session.id);
    if (!actor.user) {
      throw Object.assign(new Error('This endpoint needs an API key (Authorization: Bearer <key>) or a signed-in session.'), {
        status: 401,
        code: 'auth_required',
      });
    }
    return actor;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        });
        return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(INDEX_HTML_PATH);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // Whitelisted static assets (PWA manifest and icons).
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        try {
          const data = await readFile(new URL(`../../public/${file}`, import.meta.url));
          res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
          return res.end(data);
        } catch {
          throw Object.assign(new Error('Asset not found.'), { status: 404, code: 'not_found' });
        }
      }

      const handler = handlers[`${req.method} ${url.pathname}`];
      if (!handler) {
        throw Object.assign(new Error(`No route: ${req.method} ${url.pathname}`), { status: 404, code: 'not_found' });
      }
      await handler(req, res, url);
    } catch (err) {
      sendError(res, err);
    }
  });

  return {
    config,
    server,
    index,
    stores: { index: indexStore, users: usersStore, usage: usageStore, history: historyStore },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      index.compact();
      await Promise.all([indexStore.close(), usersStore.close(), usageStore.close(), historyStore.close()]);
    },
  };
}
