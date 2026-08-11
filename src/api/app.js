// HTTP app assembly. Plain node:http, no framework.

import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { makeConfig } from '../config.js';
import { JsonStore } from '../storage/store.js';
import { SearchIndex, emptyIndexData } from '../core/index.js';
import { search, RANKING_SIGNALS, EXCLUDED_FOREVER } from '../core/ranker.js';
import { stem } from '../core/tokenizer.js';
import {
  emptyUsersData, emptyUsageData, createAccount, resolveActor, chargeSearch, usedToday,
} from './auth.js';
import { publicPlans, subscribe, cancelSubscription } from './billing.js';

const INDEX_HTML_PATH = new URL('../../public/index.html', import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
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
  const index = new SearchIndex(indexStore);
  const startedAt = Date.now();

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
      const page = Math.max(1, Math.min(100, Number(url.searchParams.get('page')) || 1));
      const perPage = Math.max(1, Math.min(50, Number(url.searchParams.get('per_page')) || 10));

      const actor = resolveActor(req, url, usersStore.data, config);
      const usage = chargeSearch(usageStore.data, actor);
      usageStore.scheduleSave();

      const body = search(index, q, { page, perPage });
      sendJson(res, 200, { ...body, plan: actor.plan, usageToday: usage });
    },

    'GET /v1/suggest': async (_req, res, url) => {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return sendJson(res, 200, { suggestions: [] });
      const prefix = stem(q.split(/\s+/).pop());
      const matches = [];
      for (const term in index.data.postings) {
        if (!term.startsWith(prefix)) continue;
        const df = index.documentFrequency(term);
        if (df > 0) matches.push({ display: index.data.postings[term].display, df });
      }
      matches.sort((a, b) => b.df - a.df);
      const seen = new Set();
      const suggestions = [];
      for (const m of matches) {
        if (seen.has(m.display)) continue;
        seen.add(m.display);
        suggestions.push(m.display);
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
      sendJson(res, 200, publicPlans());
    },

    'GET /v1/stats': async (_req, res) => {
      sendJson(res, 200, {
        documents: index.docCount,
        terms: index.termCount,
        updatedAt: index.data.updatedAt,
      });
    },

    'POST /v1/account': async (req, res) => {
      const body = await readBody(req);
      const { user, apiKey } = createAccount(usersStore.data, body.email);
      usersStore.scheduleSave();
      sendJson(res, 201, {
        account: { id: user.id, email: user.email, plan: user.plan, createdAt: user.createdAt },
        apiKey,
        note: 'Store this API key now — it is shown only once and kept only as a hash.',
      });
    },

    'GET /v1/account': async (req, res, url) => {
      const actor = requireUser(req, url);
      sendJson(res, 200, {
        account: {
          id: actor.user.id,
          email: actor.user.email,
          plan: actor.user.plan,
          subscription: actor.user.subscription,
          createdAt: actor.user.createdAt,
        },
        usageToday: { used: usedToday(usageStore.data, actor.id), limit: actor.dailyLimit },
      });
    },

    'POST /v1/subscribe': async (req, res, url) => {
      const actor = requireUser(req, url);
      const body = await readBody(req);
      const subscription = subscribe(actor.user, body.plan || 'monthly');
      usersStore.scheduleSave();
      sendJson(res, 200, {
        subscription,
        note: 'Dev-mode activation (no payment collected). See src/api/billing.js for where real payments plug in.',
      });
    },

    'POST /v1/subscribe/cancel': async (req, res, url) => {
      const actor = requireUser(req, url);
      const subscription = cancelSubscription(actor.user);
      usersStore.scheduleSave();
      sendJson(res, 200, { subscription });
    },
  };

  function requireUser(req, url) {
    const actor = resolveActor(req, url, usersStore.data, config);
    if (!actor.user) {
      throw Object.assign(new Error('This endpoint needs an API key (Authorization: Bearer <key>).'), {
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
          'access-control-allow-methods': 'GET, POST, OPTIONS',
        });
        return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(INDEX_HTML_PATH);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
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
    stores: { index: indexStore, users: usersStore, usage: usageStore },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      index.compact();
      await Promise.all([indexStore.close(), usersStore.close(), usageStore.close()]);
    },
  };
}
