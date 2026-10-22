'use strict';

/**
 * Adds the inline photo checker (/photo-check.js) to platform pages and
 * swaps their "Add to Chrome/Firefox" buttons for "Check a photo now" on
 * phones, which can't install the extension. Most search visits to these
 * pages come from phones.
 *
 * Usage: node scripts/add-photo-check.js [slug ...]   (default: all in PAGES)
 * Idempotent: skips pages that already have the .photo-check block.
 */

const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..', 'pages');

// title: what the checker card says; source: what to screenshot on that app;
// desktop: where the extension works for the "On a computer?" note.
const PAGES = {
  instagram: {
    platform: 'Instagram',
    title: 'Check an Instagram photo now, free',
    source: 'Screenshot their profile photo or a post',
    desktop: 'right on Instagram',
  },
  tinder: {
    platform: 'Tinder',
    title: 'Check a Tinder photo now, free',
    source: 'Screenshot one of their profile photos',
    desktop: 'right on tinder.com',
  },
  facebook: {
    platform: 'Facebook',
    title: 'Check a Facebook photo now, free',
    source: 'Screenshot their profile photo or a post',
    desktop: 'right on Facebook',
  },
  // Hinge has no website, so on a computer the extension only helps on other apps.
  hinge: {
    platform: 'Hinge',
    title: 'Check a Hinge photo now, free',
    source: 'Screenshot one of their profile photos',
    desktop: 'on Tinder, Bumble and other dating sites',
  },
  linkedin: {
    platform: 'LinkedIn',
    title: 'Check a LinkedIn photo now, free',
    source: 'Screenshot their profile photo',
    desktop: 'right on LinkedIn',
  },
  bumble: {
    platform: 'Bumble',
    title: 'Check a Bumble photo now, free',
    source: 'Screenshot one of their profile photos',
    desktop: 'right on bumble.com',
  },
  grindr: {
    platform: 'Grindr',
    title: 'Check a Grindr photo now, free',
    source: 'Screenshot their profile photo',
    desktop: 'on Grindr Web',
  },
};

const CWS = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkerBlock(p) {
  return `
        <div class="photo-check" id="photo-check" data-platform="${p.platform}">
          <p class="photo-check-title">${p.title}</p>
          <p class="photo-check-help">${p.source}, crop it to just the picture, and upload it here. 3 free checks a day, no account.</p>
          <label class="photo-check-drop">
            <input type="file" accept="image/*" class="photo-check-input">
            📷 Upload a photo
          </label>
          <p class="photo-check-busy" hidden>Checking the photo…</p>
          <div class="photo-check-result" hidden aria-live="polite"></div>
        </div>`;
}

function transform(html, p) {
  const steps = [];
  const apply = (name, re, fn) => {
    const next = html.replace(re, fn);
    if (next === html) throw new Error(`step "${name}" matched nothing`);
    steps.push(name);
    html = next;
  };

  // 1. Hero extension buttons move up from below the Quick Answer so they
  //    stay on the first screen on desktop; phones get a note instead.
  let heroButtons = '';
  apply('hero buttons',
    new RegExp(`\\s*<a href="${esc(CWS)}" class="btn btn-primary btn-large"[^>]*>[^<]*</a>\\s*<a href="https://addons\\.mozilla\\.org[^>]*>[^<]*</a>\\s*<p class="landing-note">[^<]*</p>`),
    m => { heroButtons = m.trim(); return ''; });

  // 2. Checker right under the hero subtitle, then the buttons, then the Quick Answer.
  apply('hero checker', /(<div class="landing-hero">[\s\S]*?<p class="landing-subtitle">[\s\S]*?<\/p>)/, m =>
    m + checkerBlock(p) +
    `\n        <div class="desktop-only">\n          ${heroButtons}\n        </div>` +
    `\n        <p class="landing-note mobile-only">On a computer? Add Faux Spy to Chrome and check photos ${p.desktop}, no screenshots needed.</p>`);

  // 3. Nav and mid-page buttons: hide on phones, add a jump to the checker.
  apply('nav button', new RegExp(`<a href="${esc(CWS)}" class="btn btn-primary btn-small"`), m => m.replace('btn-small"', 'btn-small desktop-only"'));
  apply('mid-page button',
    new RegExp(`(<a href="${esc(CWS)}") class="btn btn-primary"( target="_blank" rel="noopener" style="display:inline-block;">)`),
    (m, a, b) => `<a href="#photo-check" class="btn btn-primary mobile-only" style="display:inline-block;">📷 Check a photo now</a>\n        ${a} class="btn btn-primary desktop-only"${b}`);

  // 4. Closing call to action.
  apply('bottom buttons',
    new RegExp(`(<div class="landing-cta">[\\s\\S]*?)<a href="${esc(CWS)}" class="btn btn-primary btn-large"([^>]*>[^<]*</a>)\\s*<a href="https://addons\\.mozilla\\.org([^"]*)" class="btn btn-secondary"`),
    (m, before, chromeRest, amoRest) =>
      `${before}<a href="#photo-check" class="btn btn-primary btn-large mobile-only">📷 Check a photo now</a>\n        <a href="${CWS}" class="btn btn-primary btn-large desktop-only"${chromeRest}\n          <a href="https://addons.mozilla.org${amoRest}" class="btn btn-secondary desktop-only"`);

  apply('script', /<\/body>/, m => `  <script defer src="/photo-check.js"></script>\n${m}`);
  return { html, steps };
}

function main() {
  const slugs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PAGES);
  for (const slug of slugs) {
    const p = PAGES[slug];
    if (!p) { console.error(`${slug}: no entry in PAGES`); process.exitCode = 1; continue; }
    const file = path.join(PAGES_DIR, `${slug}.html`);
    const html = fs.readFileSync(file, 'utf8');
    if (html.includes('class="photo-check"')) { console.log(`${slug}: already has the checker, skipped`); continue; }
    try {
      const out = transform(html, p);
      fs.writeFileSync(file, out.html, 'utf8');
      console.log(`${slug}: ${out.steps.join(', ')}`);
    } catch (err) {
      console.error(`${slug}: ${err.message}; page left unchanged`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();

module.exports = { transform, PAGES };
