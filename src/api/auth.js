// Accounts, API keys, and daily usage limits.
//
// Keys are shown once at creation and stored only as SHA-256 hashes.
// Anonymous searches are allowed (that is the free taste of the product);
// they are limited per IP per day. Accounts raise the limit; subscriptions
// effectively remove it. That ladder — not advertising — is the business.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function emptyUsersData() {
  return { users: {}, byEmail: {}, byKeyHash: {} };
}

export function emptyUsageData() {
  return { days: {} };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function createAccount(usersData, email) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normEmail)) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400, code: 'invalid_email' });
  }
  if (usersData.byEmail[normEmail]) {
    throw Object.assign(new Error('An account already exists for this email.'), { status: 409, code: 'account_exists' });
  }

  const apiKey = `key_${randomBytes(24).toString('base64url')}`;
  const user = {
    id: randomUUID(),
    email: normEmail,
    plan: 'free', // 'free' | 'subscriber'
    subscription: null,
    createdAt: new Date().toISOString(),
  };
  usersData.users[user.id] = user;
  usersData.byEmail[normEmail] = user.id;
  usersData.byKeyHash[hashKey(apiKey)] = user.id;
  return { user, apiKey };
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

// Who is making this request, and what are they allowed to do today?
export function resolveActor(req, url, usersData, config) {
  const apiKey = extractApiKey(req, url);
  if (apiKey) {
    const user = findUserByKey(usersData, apiKey);
    if (!user) {
      throw Object.assign(new Error('Unknown API key.'), { status: 401, code: 'invalid_key' });
    }
    const limit = user.plan === 'subscriber' ? config.subscriberDailyLimit : config.freeDailyLimit;
    return { id: `user:${user.id}`, user, plan: user.plan, dailyLimit: limit };
  }
  return {
    id: `ip:${clientIp(req, config)}`,
    user: null,
    plan: 'anonymous',
    dailyLimit: config.anonDailyLimit,
  };
}

const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

export function usedToday(usageData, actorId, now) {
  return usageData.days[dayKey(now)]?.[actorId] || 0;
}

// Increments the actor's counter; throws 402/429 when today's allowance is gone.
export function chargeSearch(usageData, actor, now = new Date()) {
  const day = dayKey(now);
  usageData.days[day] ??= {};
  const used = usageData.days[day][actor.id] || 0;

  if (used >= actor.dailyLimit) {
    if (actor.plan === 'subscriber') {
      throw Object.assign(new Error('Daily fair-use ceiling reached. This exists only to stop abuse — contact support if you hit it legitimately.'), {
        status: 429,
        code: 'fair_use_ceiling',
      });
    }
    const err = new Error(
      actor.plan === 'anonymous'
        ? `Free anonymous searches are limited to ${actor.dailyLimit} per day. Create a free account for more, or subscribe for effectively unlimited search.`
        : `Free accounts are limited to ${actor.dailyLimit} searches per day. Subscribe for effectively unlimited search — subscriptions are the only way this engine makes money, which is why results are never for sale.`,
    );
    throw Object.assign(err, { status: 402, code: 'subscription_required', upgrade: { createAccount: 'POST /v1/account', subscribe: 'POST /v1/subscribe' } });
  }

  usageData.days[day][actor.id] = used + 1;

  // Retention: usage counters are for limits, not surveillance. Keep 7 days.
  for (const d of Object.keys(usageData.days)) {
    if (d < dayKey(new Date(now.getTime() - 7 * 86400000))) delete usageData.days[d];
  }

  return { used: used + 1, limit: actor.dailyLimit };
}
