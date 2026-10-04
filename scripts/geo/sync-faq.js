/**
 * Faux Spy — FAQ schema/visible parity
 *
 * Google expects FAQPage JSON-LD to match the FAQ text a visitor can see.
 * On most pages the two had drifted apart (different questions, paraphrased
 * answers), so this makes the visible FAQ the single source of truth:
 *
 *   - Visible FAQ exists  -> regenerate FAQPage mainEntity from it, verbatim.
 *   - No visible FAQ but schema exists -> render a visible FAQ from the schema
 *     before the page's .landing-cta block.
 *
 * Visible FAQ formats recognised:
 *   1. <details><summary>Q</summary> answer… </details>
 *   2. <h3>Q</h3><p>answer</p>… under an h2 like "Frequently asked questions"
 *
 * Only the FAQPage JSON-LD block (and, for case 2, the inserted FAQ markup)
 * is rewritten; the rest of the file is left byte-for-byte untouched.
 *
 * Usage: node scripts/geo/sync-faq.js [--dry-run] [--only=slug,slug]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const DIRS = ['pages', 'blog'];
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);

const LD_RE = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g;
const FAQ_HEADING_RE = /frequently asked|^faq|common questions|questions people ask/i;

const norm = s => s.replace(/\s+/g, ' ').trim();
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function readVisibleFaq($) {
  const pairs = [];

  $('details').each((_, el) => {
    const summary = $(el).children('summary').first();
    if (!summary.length) return;
    // Some summaries carry a decorative toggle icon (<span>+</span>) — not part of the question.
    const s = summary.clone();
    s.children('span').each((_, span) => {
      if (/^[+\-−×▾▸›]$/.test(norm($(span).text()))) $(span).remove();
    });
    const q = norm(s.text());
    const a = norm($(el).children().not('summary').map((_, c) => $(c).text()).get().join(' '));
    if (q && a) pairs.push({ q, a });
  });
  if (pairs.length) return pairs;

  // Heading-style FAQ: walk in document order (the h2 and its h3s are often in
  // sibling wrapper divs, not siblings of each other) until the next h2.
  let inFaq = false;
  let current = null;
  $('h2, h3, p, ul, ol').each((_, el) => {
    const tag = el.tagName;
    if (tag === 'h2') {
      if (inFaq && current && current.a) pairs.push(current);
      current = null;
      inFaq = FAQ_HEADING_RE.test(norm($(el).text()));
      return;
    }
    if (!inFaq) return;
    if (tag === 'h3') {
      if (current && current.a) pairs.push(current);
      current = { q: norm($(el).text()), a: '' };
    } else if (current && !$(el).parents('ul, ol').length) {
      current.a = norm(`${current.a} ${$(el).text()}`);
    }
  });
  if (inFaq && current && current.a) pairs.push(current);
  return pairs;
}

// FAQPage can sit at the top level, in @graph, in an array, or nested (e.g. as
// an Article's mainEntity), so search the whole tree.
function findFaqNode(json) {
  if (!json || typeof json !== 'object') return null;
  if (json['@type'] === 'FAQPage') return json;
  for (const v of Object.values(json)) {
    const hit = findFaqNode(v);
    if (hit) return hit;
  }
  return null;
}

function closingIndexOfDiv(html, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < html.length; i++) {
    if (html.startsWith('<div', i) && /[\s>]/.test(html[i + 4])) depth++;
    else if (html.startsWith('</div>', i) && --depth === 0) return i + 6;
  }
  return -1;
}

// Where to insert a visible FAQ: before .landing-cta, else after the last
// .landing-section.
function faqInsertIndex(html) {
  const cta = html.indexOf('<div class="landing-cta">');
  if (cta !== -1) return html.lastIndexOf('\n', cta) + 1;
  const lastSection = html.lastIndexOf('<div class="landing-section">');
  if (lastSection === -1) return -1;
  const close = closingIndexOfDiv(html, lastSection);
  if (close === -1) return -1;
  const nl = html.indexOf('\n', close);
  return nl === -1 ? close : nl + 1;
}

function toMainEntity(pairs) {
  return pairs.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  }));
}

function renderVisibleFaq(mainEntity, eol) {
  const items = mainEntity.map(q => [
    '          <details class="faq-item">',
    `            <summary>${escHtml(norm(q.name))}</summary>`,
    `            <p>${escHtml(norm(q.acceptedAnswer.text))}</p>`,
    '          </details>',
  ].join(eol)).join(eol);
  return [
    '        <div class="landing-faq">',
    '          <h2>Frequently asked questions</h2>',
    items,
    '        </div>',
    '',
  ].join(eol);
}

function sameFaq(a, b) {
  return a.length === b.length && a.every((q, i) =>
    norm(q.name) === norm(b[i].name) && norm(q.acceptedAnswer.text) === norm(b[i].acceptedAnswer.text));
}

function processFile(file) {
  let html = fs.readFileSync(file, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const $ = cheerio.load(html);
  const visible = readVisibleFaq($);

  let faqMatch = null;
  let parseError = null;
  for (const m of html.matchAll(LD_RE)) {
    let json;
    try { json = JSON.parse(m[2]); } catch (e) {
      if (m[2].includes('FAQPage')) parseError = e.message;
      continue;
    }
    const node = findFaqNode(json);
    if (node) { faqMatch = { m, json, node }; break; }
  }

  if (parseError && !faqMatch) return { status: 'json-error', detail: parseError };
  if (!faqMatch && !visible.length) return { status: 'no-faq' };

  if (!faqMatch && visible.length) {
    // Visible FAQ with no schema: add a FAQPage block before </head>.
    const block = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: toMainEntity(visible) }, null, 2);
    const tag = `  <script type="application/ld+json">${eol}${block.replace(/\n/g, eol)}${eol}  </script>${eol}`;
    if (!DRY_RUN) fs.writeFileSync(file, html.replace('</head>', `${tag}</head>`), 'utf8');
    return { status: 'schema-added', visible: visible.length };
  }

  const { m, json, node } = faqMatch;
  const schemaQs = node.mainEntity || [];

  if (visible.length) {
    const fresh = toMainEntity(visible);
    if (sameFaq(schemaQs, fresh)) return { status: 'in-sync', visible: visible.length };
    node.mainEntity = fresh;
    const body = JSON.stringify(json, null, 2).replace(/\n/g, `${eol}  `);
    const replacement = `${m[1]}${eol}  ${body}${eol}  ${m[3]}`;
    if (!DRY_RUN) {
      html = html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length);
      fs.writeFileSync(file, html, 'utf8');
    }
    return { status: 'schema-synced', before: schemaQs.length, after: fresh.length };
  }

  // Schema but nothing visible: show the schema's Q&As on the page.
  const insertAt = faqInsertIndex(html);
  if (insertAt === -1) return { status: 'no-anchor', schema: schemaQs.length };
  if (!DRY_RUN) {
    html = html.slice(0, insertAt) + renderVisibleFaq(schemaQs, eol) + html.slice(insertAt);
    fs.writeFileSync(file, html, 'utf8');
  }
  return { status: 'visible-added', schema: schemaQs.length };
}

const tally = {};
const notable = [];
for (const dir of DIRS) {
  const abs = path.join(SITE_ROOT, dir);
  for (const f of fs.readdirSync(abs).filter(f => f.endsWith('.html'))) {
    const slug = `${dir}/${f.replace('.html', '')}`;
    if (ONLY.length && !ONLY.includes(slug) && !ONLY.includes(f.replace('.html', ''))) continue;
    const r = processFile(path.join(abs, f));
    tally[r.status] = (tally[r.status] || 0) + 1;
    if (!['in-sync', 'no-faq'].includes(r.status)) notable.push(`${r.status.padEnd(14)} ${slug} ${JSON.stringify(r)}`);
  }
}

console.log(DRY_RUN ? 'DRY RUN — no files written\n' : '');
notable.forEach(l => console.log(l));
console.log('\nSummary:', tally);
