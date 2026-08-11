// Search history — yours, inspectable, deletable.
//
// History exists for exactly one reason: so *you* can find your way back to
// things you searched. It is never used for ranking, never used for ads
// (there are none), and never sold. It is keyed to your account if you have
// one, otherwise to an anonymous ns_session cookie, and one call wipes it.
//
// Retention: 90 days, capped at 200 entries per owner, oldest dropped first.

const MAX_ENTRIES = 200;
const RETENTION_DAYS = 90;

export function emptyHistoryData() {
  return { owners: {} };
}

// Record a search. Consecutive repeats of the same query collapse into one
// entry with a bumped count instead of flooding the list.
export function recordSearch(data, ownerId, query, total, now = new Date()) {
  const at = now.toISOString();
  const entries = (data.owners[ownerId] ??= []);
  const last = entries[entries.length - 1];
  if (last && last.q === query) {
    last.at = at;
    last.n += 1;
    last.total = total;
  } else {
    entries.push({ q: query, at, n: 1, total });
  }

  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  data.owners[ownerId] = entries.filter((e) => e.at >= cutoff).slice(-MAX_ENTRIES);
}

export function listHistory(data, ownerId, limit = 20) {
  const entries = data.owners[ownerId] || [];
  return entries
    .slice(-Math.max(1, Math.min(100, limit)))
    .reverse()
    .map((e) => ({ query: e.q, lastSearchedAt: e.at, times: e.n, resultsLastTime: e.total }));
}

export function clearHistory(data, ownerId) {
  const had = (data.owners[ownerId] || []).length;
  delete data.owners[ownerId];
  return had;
}

export function removeHistoryEntry(data, ownerId, query) {
  const entries = data.owners[ownerId];
  if (!entries) return 0;
  const before = entries.length;
  data.owners[ownerId] = entries.filter((e) => e.q !== query);
  if (data.owners[ownerId].length === 0) delete data.owners[ownerId];
  return before - (data.owners[ownerId]?.length || 0);
}
