/**
 * Faux Spy — Link cited sources on statistics pages
 *
 * The statistics pages name their sources dozens of times ("FBI IC3",
 * "FTC", "Pew Research") but never linked to them. AI answer engines weigh
 * verifiable citations heavily when choosing what to quote, so this:
 *
 *   1. Links the FIRST mention of each source in the page's body text to its
 *      primary document (skipping headings, existing links, nav, footer,
 *      FAQ summaries and anything outside <body>).
 *   2. Adds a visible "Sources" list before the page's FAQ / CTA.
 *
 * Sources and their verified URLs live in scripts/geo/sources.json.
 * Idempotent: a source already linked on the page is skipped, and the
 * Sources list is marked with data-geo="sources".
 *
 * Usage: node scripts/geo/link-sources.js [--dry-run] [files...]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');
const { sources } = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

const DEFAULT_FILES = [
  'pages/romance-scam-statistics.html',
  'pages/catfishing-statistics.html',
  'pages/ai-fraud-statistics.html',
  'pages/online-dating-statistics.html',
  'pages/deepfake-statistics.html',
  'pages/sextortion-statistics.html',
  'pages/fake-dating-profile-statistics.html',
  'blog/catfishing-statistics.html',
  'blog/romance-scam-stats.html',
  'blog/deepfake-fraud-statistics.html',
];
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const FILES = args.length ? args : DEFAULT_FILES;

// Text inside these elements is never linked.
const SKIP_TAGS = new Set(['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'script', 'style', 'nav', 'footer', 'summary', 'button', 'title', 'noscript', 'svg', 'option']);
const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr', 'area', 'col', 'embed', 'track']);

const anchor = (s, text) =>
  `<a href="${s.url}" target="_blank" rel="noopener" style="color:var(--gold,#fbbf24);">${text}</a>`;

function linkFirstMentions(html, wanted) {
  const bodyStart = html.search(/<body[\s>]/i);
  if (bodyStart === -1) return { html, linked: [] };
  const head = html.slice(0, bodyStart);
  const body = html.slice(bodyStart);

  const pending = new Map(wanted.map(s => [s.id, { s, re: new RegExp(s.pattern) }]));
  const linked = [];
  const skipStack = [];
  const out = body.replace(/<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g, (tok, tag) => {
    if (tok.startsWith('<!--')) return tok;
    if (tag) {
      const name = tag.toLowerCase();
      if (VOID.has(name) || tok.endsWith('/>')) return tok;
      if (tok.startsWith('</')) {
        const i = skipStack.lastIndexOf(name);
        if (i !== -1) skipStack.splice(i, 1);
      } else if (SKIP_TAGS.has(name)) {
        skipStack.push(name);
      }
      return tok;
    }
    if (skipStack.length || !pending.size) return tok;
    let text = tok;
    for (const [id, { s, re }] of pending) {
      const m = re.exec(text);
      if (!m) continue;
      text = text.slice(0, m.index) + anchor(s, m[0]) + text.slice(m.index + m[0].length);
      pending.delete(id);
      linked.push(id);
    }
    return text;
  });
  return { html: head + out, linked };
}

function sourcesBlock(list, eol) {
  return [
    '        <div class="landing-section" data-geo="sources">',
    '          <h2>Sources</h2>',
    '          <ul>',
    ...list.map(s => `            <li><a href="${s.url}" target="_blank" rel="noopener" style="color:var(--gold,#fbbf24);">${s.label}</a></li>`),
    '          </ul>',
    '        </div>',
    '',
  ].join(eol);
}

// Some pages already have a hand-written (unlinked) Sources list. Link the
// items that name a source, append any cited source it's missing, and mark
// the list so we don't add a second Sources section.
function mergeIntoExistingList(html, cited, eol) {
  const h2 = html.search(/<h2[^>]*>\s*Sources\s*<\/h2>/);
  if (h2 === -1) return null;
  const ulOpen = html.indexOf('<ul', h2);
  const ulClose = html.indexOf('</ul>', ulOpen);
  if (ulOpen === -1 || ulClose === -1) return null;
  const tagEnd = html.indexOf('>', ulOpen) + 1;
  let list = html.slice(tagEnd, ulClose);
  const indent = (list.match(/\n([ \t]*)<li/) || [, '          '])[1];

  for (const s of cited) {
    const re = new RegExp(s.pattern);
    let done = false;
    list = list.replace(/<li([^>]*)>([\s\S]*?)<\/li>/g, (li, attrs, inner) => {
      if (done || inner.includes('<a ') || !re.test(inner)) return li;
      done = true;
      return `<li${attrs}>${anchor(s, inner)}</li>`;
    });
    if (!done && !list.includes(`href="${s.url}"`)) {
      list = list.replace(/\s*$/, '') + `${eol}${indent}<li>${anchor(s, s.label)}</li>${eol}${indent.slice(2)}`;
    }
  }
  const openTag = html.slice(ulOpen, tagEnd).replace('<ul', '<ul data-geo="sources"');
  return html.slice(0, ulOpen) + openTag + list + html.slice(ulClose);
}

function sourcesInsertIndex(html) {
  for (const marker of ['<div class="landing-faq">', '<div class="landing-cta">']) {
    const i = html.indexOf(marker);
    if (i !== -1) return html.lastIndexOf('\n', i) + 1;
  }
  return -1;
}

for (const rel of FILES) {
  const file = path.join(SITE_ROOT, rel);
  let html = fs.readFileSync(file, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';

  const cited = sources.filter(s => new RegExp(s.pattern).test(html.replace(/<script[\s\S]*?<\/script>/g, ''))
    && (!s.onlyIfPageMentions || html.includes(s.onlyIfPageMentions))
    && !(s.skipFiles || []).includes(rel));
  const wanted = cited.filter(s => !html.includes(`href="${s.url}"`));

  const { html: linkedHtml, linked } = linkFirstMentions(html, wanted);
  html = linkedHtml;

  let listNote = 'list exists';
  const merged = !html.includes('data-geo="sources"') && cited.length ? mergeIntoExistingList(html, cited, eol) : null;
  if (merged) {
    html = merged;
    listNote = 'merged into existing Sources list';
  } else if (!html.includes('data-geo="sources"') && cited.length) {
    const at = sourcesInsertIndex(html);
    if (at === -1) listNote = 'NO ANCHOR for Sources list';
    else { html = html.slice(0, at) + sourcesBlock(cited, eol) + html.slice(at); listNote = `list of ${cited.length}`; }
  }

  if (!DRY_RUN) fs.writeFileSync(file, html, 'utf8');
  const missed = wanted.map(s => s.id).filter(id => !linked.includes(id));
  console.log(`${rel.padEnd(42)} linked: ${linked.join(', ') || '-'}${missed.length ? ` | not found in body text: ${missed.join(', ')}` : ''} | ${listNote}`);
}
if (DRY_RUN) console.log('\nDRY RUN — no files written');
