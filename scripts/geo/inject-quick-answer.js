/**
 * Faux Spy — Quick Answer + question headings + freshness
 *
 * AI answer engines and featured snippets favour pages that answer the
 * question in the first lines, use the question people actually search as a
 * heading, and show when they were last checked. For each entry in
 * scripts/geo/quick-answers.json this:
 *
 *   1. Inserts a Quick Answer box right after the intro paragraph that
 *      follows the <h1> (skipped if the page already has one).
 *   2. Renames statement-style <h2>s to their question form.
 *   3. Sets a visible "Last updated" date and syncs JSON-LD dateModified,
 *      plus any existing "Updated <Month> <Year>" line, to the same date.
 *
 * Answers are written by hand in the JSON file. Only pages whose content
 * actually changes here get a new date.
 *
 * Usage: node scripts/geo/inject-quick-answer.js [--dry-run] [--date=YYYY-MM-DD]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');
const DATE = (process.argv.find(a => a.startsWith('--date=')) || '').replace('--date=', '') || new Date().toISOString().slice(0, 10);
const MONTH_YEAR = new Date(`${DATE}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const { entries } = JSON.parse(fs.readFileSync(path.join(__dirname, 'quick-answers.json'), 'utf8'));

function quickAnswerBlock(answer, eol) {
  return [
    '',
    '        <div data-geo="quick-answer" style="background:var(--noir-card,#1e2536);border:1px solid var(--border-default,rgba(251,191,36,0.15));border-radius:12px;padding:1.25rem 1.5rem;margin:1.5rem 0 2rem;position:relative;overflow:hidden;">',
    '          <div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(to bottom,#facc15,#ca8a04);"></div>',
    '          <p style="margin:0 0 0.5rem;font-size:0.75rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted,#94a3b8);">Quick Answer</p>',
    `          <p style="margin:0;color:var(--text-primary,#f8fafc);line-height:1.6;">${answer}</p>`,
    `          <p style="margin:0.75rem 0 0;font-size:0.75rem;color:var(--text-muted,#94a3b8);">Last updated <time datetime="${DATE}">${MONTH_YEAR}</time></p>`,
    '        </div>',
  ].join(eol);
}

// End of the first <p>…</p> after </h1>.
function introEnd(html) {
  const h1 = html.indexOf('</h1>');
  if (h1 === -1) return -1;
  const p = html.indexOf('<p', h1);
  if (p === -1) return -1;
  const close = html.indexOf('</p>', p);
  return close === -1 ? -1 : close + 4;
}

const report = [];
for (const e of entries) {
  const file = path.join(SITE_ROOT, e.file);
  let html = fs.readFileSync(file, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const notes = [];

  if (e.answer) {
    if (html.includes('data-geo="quick-answer"') || />\s*Quick Answer\s*</.test(html)) {
      notes.push('QA exists');
    } else {
      const at = introEnd(html);
      if (at === -1) notes.push('QA: NO ANCHOR');
      else { html = html.slice(0, at) + quickAnswerBlock(e.answer, eol) + html.slice(at); notes.push('QA added'); }
    }
  }

  for (const [from, to] of Object.entries(e.headings || {})) {
    // Some headings wrap their text in <strong>; keep the wrapper if present.
    const re = new RegExp(`(<h2[^>]*>\\s*(?:<strong>)?)\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*((?:</strong>)?\\s*</h2>)`);
    if (re.test(html)) { html = html.replace(re, (_, open, close) => `${open}${to}${close}`); notes.push(`h2 ✓`); }
    else if (html.includes(`>${to}</h2>`) || html.includes(`>${to}</strong></h2>`)) notes.push('h2 already');
    else notes.push(`h2 MISSING: "${from}"`);
  }

  html = html.replace(/("dateModified":\s*")[^"]+(")/g, `$1${DATE}$2`);
  html = html.replace(/\bUpdated (January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d\b/g, `Updated ${MONTH_YEAR}`);

  if (!DRY_RUN) fs.writeFileSync(file, html, 'utf8');
  report.push(`${e.file.padEnd(42)} ${notes.join(' | ')}`);
}
console.log(report.join('\n'));
if (DRY_RUN) console.log('\nDRY RUN — no files written');
