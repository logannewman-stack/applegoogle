// HTML -> { title, description, text, links, lang, noindex, canonical }
//
// Regex-based extraction, no DOM dependency. It will not survive every page
// on the web, but it is predictable, fast, and easily replaced by a real
// HTML parser behind this same function signature.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

export function extract(html, { maxTextLength = 200000 } = {}) {
  const src = String(html);

  const lang = src.match(/<html[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i)?.[1] || null;

  const titleRaw = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const title = decodeEntities(titleRaw).replace(/\s+/g, ' ').trim();

  let description = '';
  let noindex = false;
  let canonical = null;
  const headMetaRe = /<(meta|link)\b[^>]*>/gi;
  let m;
  while ((m = headMetaRe.exec(src)) !== null) {
    const tag = m[0];
    if (m[1].toLowerCase() === 'meta') {
      const name = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
      if ((name === 'description' || name === 'og:description') && !description) {
        description = (attr(tag, 'content') || '').replace(/\s+/g, ' ').trim();
      }
      if (name === 'robots' && /noindex/i.test(attr(tag, 'content') || '')) noindex = true;
    } else {
      const rel = (attr(tag, 'rel') || '').toLowerCase();
      if (rel === 'canonical' && !canonical) canonical = attr(tag, 'href');
    }
  }

  // Links (with rel=nofollow respected — nofollowed links earn no authority).
  const links = [];
  const aRe = /<a\b[^>]*>/gi;
  while ((m = aRe.exec(src)) !== null) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (rel.includes('nofollow')) continue;
    const href = attr(tag, 'href');
    if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:')) links.push(href);
    if (links.length >= 500) break;
  }

  // Visible text: drop non-content blocks, then strip tags.
  let text = src
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text
    .replace(/<(p|div|br|li|h[1-6]|tr|td|th|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  if (text.length > maxTextLength) text = text.slice(0, maxTextLength);

  return { title, description, text: text.replace(/\n/g, ' '), links, lang, noindex, canonical };
}
