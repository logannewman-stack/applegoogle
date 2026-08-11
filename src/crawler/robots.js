// Minimal robots.txt parser and matcher.
//
// Follows the longest-match rule from RFC 9309: for a given path, the most
// specific Allow/Disallow rule wins; ties go to Allow. Supports * wildcards
// and $ end anchors. A missing or unreadable robots.txt means "allowed".

function ruleToRegex(rule) {
  let pattern = '';
  for (const ch of rule) {
    if (ch === '*') pattern += '.*';
    else if (ch === '$') pattern += '$';
    else pattern += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}`);
}

export function parseRobots(text, userAgent) {
  const uaToken = userAgent.split('/')[0].toLowerCase();
  const groups = []; // { agents: [], rules: [{allow, path}], crawlDelay }
  let current = null;
  let lastLineWasAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastLineWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'disallow' || field === 'allow') {
      if (value) current.rules.push({ allow: field === 'allow', path: value });
      // "Disallow:" with empty value means allow everything — no rule needed.
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  // Pick the group for our UA, else the * group.
  let chosen = groups.find((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  if (!chosen) chosen = groups.find((g) => g.agents.includes('*'));

  const rules = (chosen?.rules || []).map((r) => ({
    allow: r.allow,
    path: r.path,
    regex: ruleToRegex(r.path),
    specificity: r.path.length,
  }));

  return {
    crawlDelay: chosen?.crawlDelay ?? null,
    isAllowed(path) {
      let best = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !best ||
          rule.specificity > best.specificity ||
          (rule.specificity === best.specificity && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

export class RobotsCache {
  constructor({ userAgent, timeoutMs = 8000, fetchImpl = fetch } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.cache = new Map(); // origin -> parsed robots
  }

  async forOrigin(origin) {
    if (this.cache.has(origin)) return this.cache.get(origin);
    let parsed;
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      if (res.ok) {
        parsed = parseRobots(await res.text(), this.userAgent);
      } else if (res.status >= 500) {
        // Server trouble: be conservative, treat as fully disallowed for now.
        parsed = { crawlDelay: null, isAllowed: () => false };
      } else {
        parsed = parseRobots('', this.userAgent); // 4xx: no robots -> allowed
      }
    } catch {
      parsed = parseRobots('', this.userAgent); // network failure -> allowed, but crawler timeouts still apply
    }
    this.cache.set(origin, parsed);
    return parsed;
  }

  async isAllowed(url) {
    const u = new URL(url);
    const robots = await this.forOrigin(u.origin);
    return robots.isAllowed(u.pathname + u.search);
  }

  async crawlDelayFor(url) {
    const robots = await this.forOrigin(new URL(url).origin);
    return robots.crawlDelay;
  }
}
