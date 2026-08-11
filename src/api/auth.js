// Accounts, API keys, and usage limits.
//
// Keys are shown once at creation and stored only as SHA-256 hashes.
// Northstar is free: anonymous visitors and account holders alike get the
// same engine and the same anti-abuse fair-use ceiling. There are no tiers.
// (The eventual business model is a subscription — never advertising.)

import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function emptyUsersData() {
  return { users: {}, byEmail: {}, byKeyHash: {}, sessionLinks: {} };
}

export function emptyUsageData() {
  return { days: {} };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function cleanName(name) {
  const cleaned = String(name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || null;
}

export function createAccount(usersData, email, name) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normEmail)) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400, code: 'invalid_email' });
  }
  if (usersData.byEmail[normEmail]) {
    throw Object.assign(new Error('An account already exists for this email.'), { status: 409, code: 'account_exists' });
  }

  const apiKey = `ns_${randomBytes(24).toString('base64url')}`;
  const user = {
    id: randomUUID(),
    email: normEmail,
    name: cleanName(name),
    settings: {},
    createdAt: new Date().toISOString(),
  };
  usersData.users[user.id] = user;
  usersData.byEmail[normEmail] = user.id;
  usersData.byKeyHash[hashKey(apiKey)] = user.id;
  return { user, apiKey };
}

// Bind a browser session to an account so the web app is signed in without
// ever holding the API key in the page.
export function linkSession(usersData, sessionId, userId) {
  usersData.sessionLinks ??= {};
  usersData.sessionLinks[sessionId] = userId;
}

export function unlinkSession(usersData, sessionId) {
  if (usersData.sessionLinks) delete usersData.sessionLinks[sessionId];
}

export function userForSession(usersData, sessionId) {
  const id = usersData.sessionLinks?.[sessionId];
  return id ? usersData.users[id] || null : null;
}

export function findUserByKey(usersData, apiKey) {
  if (!apiKey) return null;
  const id = usersData.byKeyHash[hashKey(apiKey)];
  return id ? usersData.users[id] || null : null;
}

export function extractApiKey(req, url) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return url.searchParams.get('key') || null;
}

export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Who is making this request? Credentials, in order of preference: explicit
// API key, then an account bound to the browser session cookie, then
// anonymous-by-IP. Everyone gets the same engine and the same fair-use
// ceiling — there are no tiers.
export function resolveActor(req, url, usersData, config, sessionId = null) {
  const apiKey = extractApiKey(req, url);
  const actor = (user) => ({
    id: user ? `user:${user.id}` : `ip:${clientIp(req, config)}`,
    user,
    plan: user ? 'account' : 'anonymous',
    dailyLimit: config.dailyFairUseCeiling,
  });

  if (apiKey) {
    const user = findUserByKey(usersData, apiKey);
    if (!user) {
      throw Object.assign(new Error('Unknown API key.'), { status: 401, code: 'invalid_key' });
    }
    return actor(user);
  }

  if (sessionId) {
    const user = userForSession(usersData, sessionId);
    if (user) return actor(user);
  }

  return actor(null);
}

const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

export function usedToday(usageData, actorId, now) {
  return usageData.days[dayKey(now)]?.[actorId] || 0;
}

// Increments the actor's counter. Northstar is free — the only refusal is a
// high fair-use ceiling (identical for everyone) that exists to stop abuse.
export function chargeSearch(usageData, actor, now = new Date()) {
  const day = dayKey(now);
  usageData.days[day] ??= {};
  const used = usageData.days[day][actor.id] || 0;

  if (used >= actor.dailyLimit) {
    throw Object.assign(
      new Error(`Fair-use ceiling reached (${actor.dailyLimit} searches today). Northstar is free and has no tiers — this ceiling exists only to stop abuse, and it resets at midnight UTC.`),
      { status: 429, code: 'fair_use_ceiling' },
    );
  }

  usageData.days[day][actor.id] = used + 1;

  // Retention: usage counters are for limits, not surveillance. Keep 7 days.
  for (const d of Object.keys(usageData.days)) {
    if (d < dayKey(new Date(now.getTime() - 7 * 86400000))) delete usageData.days[d];
  }

  return { used: used + 1, limit: actor.dailyLimit };
}
