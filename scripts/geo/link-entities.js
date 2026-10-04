/**
 * Faux Spy — Entity linking for JSON-LD
 *
 * AI answer engines and Google build a knowledge graph from structured data.
 * Every page described its publisher as a free-floating "Faux Spy"
 * Organization (four different shapes, some pointing at a tiny favicon as the
 * logo), so nothing tied the 187 articles to the one Organization entity
 * defined on the home page. This makes every Faux Spy Organization node
 * reference https://www.fauxspy.com/#organization, and gives definition and
 * statistics pages an `about` link to the Wikipedia topic they cover.
 *
 * Only JSON-LD blocks that actually change are rewritten.
 *
 * Usage: node scripts/geo/link-entities.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');
const LD_RE = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g;

const ORG = {
  '@type': 'Organization',
  '@id': 'https://www.fauxspy.com/#organization',
  name: 'Faux Spy',
  url: 'https://www.fauxspy.com/',
  logo: { '@type': 'ImageObject', url: 'https://www.fauxspy.com/logo.png', width: 128, height: 128 },
};

const wiki = (name, slug) => ({ '@type': 'Thing', name, sameAs: `https://en.wikipedia.org/wiki/${slug}` });
const ABOUT = {
  'what-is-catfishing': wiki('Catfishing', 'Catfishing'),
  'what-is-a-deepfake': wiki('Deepfake', 'Deepfake'),
  'what-is-a-romance-scam': wiki('Romance scam', 'Romance_scam'),
  'what-is-c2pa-content-credentials': wiki('Content Credentials', 'Content_Credentials'),
  'pig-butchering-scam': wiki('Pig butchering scam', 'Pig_butchering_scam'),
  'romance-scam-statistics': wiki('Romance scam', 'Romance_scam'),
  'catfishing-statistics': wiki('Catfishing', 'Catfishing'),
  'fake-dating-profile-statistics': wiki('Catfishing', 'Catfishing'),
  'deepfake-statistics': wiki('Deepfake', 'Deepfake'),
  'sextortion-statistics': wiki('Sextortion', 'Sextortion'),
  'online-dating-statistics': wiki('Online dating', 'Online_dating'),
  'ai-fraud-statistics': wiki('Fraud', 'Fraud'),
  'blog/catfishing-statistics': wiki('Catfishing', 'Catfishing'),
  'blog/romance-scam-stats': wiki('Romance scam', 'Romance_scam'),
  'blog/deepfake-fraud-statistics': wiki('Deepfake', 'Deepfake'),
};

const isFauxSpyOrg = o => o && typeof o === 'object' && !Array.isArray(o)
  && o['@type'] === 'Organization' && o.name === 'Faux Spy';
const isArticle = t => [].concat(t || []).some(x => ['Article', 'BlogPosting', 'NewsArticle'].includes(x));

function rewrite(node, about) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => rewrite(n, about));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = ['publisher', 'author', 'creator'].includes(k) && isFauxSpyOrg(v) ? { ...ORG } : rewrite(v, about);
  }
  if (about && isArticle(out['@type']) && !out.about) out.about = about;
  return out;
}

const tally = { files: 0, blocks: 0 };
for (const dir of ['pages', 'blog']) {
  for (const f of fs.readdirSync(path.join(SITE_ROOT, dir)).filter(f => f.endsWith('.html') && f !== 'index.html')) {
    const file = path.join(SITE_ROOT, dir, f);
    const slug = dir === 'blog' ? `blog/${f.replace('.html', '')}` : f.replace('.html', '');
    let html = fs.readFileSync(file, 'utf8');
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    let changed = 0;
    html = html.replace(LD_RE, (whole, open, body, close) => {
      const before = JSON.parse(body);
      const after = rewrite(before, ABOUT[slug]);
      if (JSON.stringify(before) === JSON.stringify(after)) return whole;
      changed++;
      return `${open}${eol}  ${JSON.stringify(after, null, 2).replace(/\n/g, `${eol}  `)}${eol}  ${close}`;
    });
    if (changed) {
      tally.files++; tally.blocks += changed;
      if (!DRY_RUN) fs.writeFileSync(file, html, 'utf8');
    }
  }
}
console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}rewrote ${tally.blocks} JSON-LD blocks in ${tally.files} files`);
