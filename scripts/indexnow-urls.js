// Prints the sitemap URLs whose page files changed, one per line, for the
// IndexNow workflow. Bing asks for changed URLs only; resubmitting the whole
// sitemap on every push (even CSS or API-only ones) wears out its trust.
//
// Usage: git diff --name-only A B | node scripts/indexnow-urls.js
//        node scripts/indexnow-urls.js --all     (every sitemap URL)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

if (process.argv.includes('--all')) {
  console.log(urls.join('\n'));
  process.exit(0);
}

// Same lookup as Vercel with cleanUrls: /x is x.html, pages/x.html or
// x/index.html (the pages/ ones are vercel.json rewrites).
function filesFor(url) {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  if (!p) return ['index.html'];
  return [`${p}.html`, `pages/${p}.html`, `${p}/index.html`];
}

const changed = new Set(fs.readFileSync(0, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
const hits = urls.filter(u => filesFor(u).some(f => changed.has(f)));
if (hits.length) console.log(hits.join('\n'));
