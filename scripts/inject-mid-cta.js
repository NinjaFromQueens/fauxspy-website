/**
 * Faux Spy — Mid-Content CTA Injector
 * Injects a "Checking a profile right now?" CTA block after the first
 * landing-section on every page in pages/ and blog/.
 *
 * Idempotent: skips pages that already have the .inline-cta block.
 * Usage: node scripts/inject-mid-cta.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(SITE_ROOT, 'pages');
const BLOG_DIR = path.join(SITE_ROOT, 'blog');
const CWS_URL = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';

// Context-aware CTA copy based on page slug pattern
function getCTACopy(slug) {
  if (slug.includes('romance-scam') || slug.includes('catfish') || slug.includes('dating')) {
    return 'Checking a profile right now?';
  }
  if (slug.includes('detector') || slug.includes('deepfake') || slug.includes('ai-')) {
    return 'Want to try it on a real image?';
  }
  if (slug.includes('pig-butchering') || slug.includes('military') || slug.includes('sextortion') || slug.includes('scam')) {
    return 'Spot AI-generated photos before you get scammed.';
  }
  if (slug.includes('blog')) {
    return 'See an image you want to check?';
  }
  return 'Checking a profile right now?';
}

function buildCTABlock(slug) {
  const copy = getCTACopy(slug);
  return `
      <div class="inline-cta" style="background:var(--noir-card,#1e2536);border:1px solid var(--border-default,rgba(251,191,36,0.15));border-radius:12px;padding:1.25rem 1.5rem;margin:2rem 0;text-align:center;">
        <p style="margin:0 0 0.75rem;font-weight:600;color:var(--text-primary,#f8fafc);">${copy}</p>
        <a href="${CWS_URL}" class="btn btn-primary" target="_blank" rel="noopener" style="display:inline-block;">&#x1F575;&#xFE0F; Add to Chrome &#x2014; Free</a>
        <p style="margin:0.6rem 0 0;font-size:0.82rem;color:var(--text-muted,#94a3b8);">10 checks/day free &middot; No account required</p>
      </div>`;
}

function processFile(filePath, slug) {
  let html = fs.readFileSync(filePath, 'utf8');

  // Skip if already injected
  if (html.includes('class="inline-cta"')) return 'skip';

  // Find the closing </div> of the FIRST landing-section
  const sectionOpen = '<div class="landing-section">';
  const firstIdx = html.indexOf(sectionOpen);
  if (firstIdx === -1) return 'no-section';

  // Find the matching closing </div> for the first landing-section
  let depth = 0;
  let i = firstIdx;
  let closingIdx = -1;

  while (i < html.length) {
    if (html.slice(i, i + 5) === '<div ') depth++;
    else if (html.slice(i, i + 4) === '<div') depth++;
    else if (html.slice(i, i + 6) === '</div>') {
      depth--;
      if (depth === 0) {
        closingIdx = i + 6;
        break;
      }
    }
    i++;
  }

  if (closingIdx === -1) return 'no-close';

  const ctaBlock = buildCTABlock(slug);
  html = html.slice(0, closingIdx) + '\n' + ctaBlock + html.slice(closingIdx);
  fs.writeFileSync(filePath, html, 'utf8');
  return 'updated';
}

function scanDir(dir, prefix) {
  if (!fs.existsSync(dir)) return { updated: 0, skipped: 0, errors: 0 };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'index.html');
  let updated = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const slug = prefix ? `${prefix}/${file.replace('.html', '')}` : file.replace('.html', '');
    const result = processFile(filePath, slug);
    if (result === 'updated') { updated++; process.stdout.write('.'); }
    else if (result === 'skip') skipped++;
    else { errors++; console.log(`\n  WARN (${result}): ${file}`); }
  }
  return { updated, skipped, errors };
}

console.log('🕵️  Injecting mid-content CTAs...');
process.stdout.write('pages/ ');
const pagesResult = scanDir(PAGES_DIR, '');
console.log(` ${pagesResult.updated} updated, ${pagesResult.skipped} skipped`);

process.stdout.write('blog/  ');
const blogResult = scanDir(BLOG_DIR, 'blog');
console.log(` ${blogResult.updated} updated, ${blogResult.skipped} skipped`);

const total = pagesResult.updated + blogResult.updated;
console.log(`\n✅ Done: ${total} pages updated`);
