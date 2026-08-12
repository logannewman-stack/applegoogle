// Per-account search settings — "make the engine fit you."
//
// Every setting here is a *behavior* preference: how many results, where
// links open, whether history is kept. None of them touch ranking — the
// covenant in INTEGRITY.md holds even against the user's own settings, which
// is exactly what makes the ranking trustworthy.

export const DEFAULT_SETTINGS = {
  resultsPerPage: 10, //   how many results per page (5–50)
  openInNewTab: false, //  open result links in a new tab
  // Reasoning is shown by default. A search engine whose promise is that it
  // explains itself should not hide the explanation behind a click.
  autoExpandWhy: true,
  suggestions: true, //    suggest completions while typing
  saveHistory: true, //    false = every search is treated as private
  theme: 'system', //      'system' | 'light' | 'dark'
};

const VALIDATORS = {
  resultsPerPage: (v) => Number.isInteger(v) && v >= 5 && v <= 50,
  openInNewTab: (v) => typeof v === 'boolean',
  autoExpandWhy: (v) => typeof v === 'boolean',
  suggestions: (v) => typeof v === 'boolean',
  saveHistory: (v) => typeof v === 'boolean',
  theme: (v) => ['system', 'light', 'dark'].includes(v),
};

export function settingsFor(user) {
  return { ...DEFAULT_SETTINGS, ...(user?.settings || {}) };
}

// Validates and applies a partial update. Unknown keys and invalid values
// are hard errors — a settings store that silently drops input teaches
// users not to trust it.
export function applySettings(user, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('Settings must be a JSON object.'), { status: 400, code: 'invalid_settings' });
  }
  for (const [key, value] of Object.entries(patch)) {
    // Own-property check only — bracket lookup would walk the prototype
    // chain and treat 'constructor'/'__proto__' as known keys.
    const validate = Object.hasOwn(VALIDATORS, key) ? VALIDATORS[key] : null;
    if (!validate) {
      throw Object.assign(new Error(`Unknown setting '${key}'. Available: ${Object.keys(VALIDATORS).join(', ')}.`), {
        status: 400,
        code: 'unknown_setting',
      });
    }
    if (!validate(value)) {
      throw Object.assign(new Error(`Invalid value for '${key}'.`), { status: 400, code: 'invalid_setting_value' });
    }
  }
  user.settings = { ...(user.settings || {}), ...patch };
  return settingsFor(user);
}

// True if history should be recorded for this user (defaults to yes).
export function historyEnabled(user) {
  return settingsFor(user).saveHistory !== false;
}
