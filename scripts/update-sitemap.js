/**
 * Faux Spy — Sitemap Regenerator
 * Scans all HTML files and rebuilds sitemap.xml, preserving existing priorities.
 * Safe to run at any time — non-destructive (reads existing sitemap first).
 *
 * Usage: node scripts/update-sitemap.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..');
const SITEMAP_FILE = path.join(SITE_ROOT, 'sitemap.xml');
const SITE_BASE = 'https://www.fauxspy.com';
const TODAY = new Date().toISOString().split('T')[0];

// Pages to exclude from sitemap (utility/auth pages)
const EXCLUDED_SLUGS = new Set([
  'account', 'buy-tokens', 'upgrade', 'pro-video', 'settings', 'product-hunt',
]);

// Manually curated priority overrides — these override the defaults
const PRIORITY_MAP = {
  '':                              { priority: '1.0', changefreq: 'weekly' },
  'pro':                           { priority: '0.9', changefreq: 'monthly' },
  'faq':                           { priority: '0.8', changefreq: 'monthly' },
  'deepfake-detector':             { priority: '0.8', changefreq: 'monthly' },
  'catfish-detector':              { priority: '0.8', changefreq: 'monthly' },
  'dating-apps':                   { priority: '0.8', changefreq: 'monthly' },
  'instagram':                     { priority: '0.8', changefreq: 'monthly' },
  'linkedin':                      { priority: '0.8', changefreq: 'monthly' },
  'facebook':                      { priority: '0.8', changefreq: 'monthly' },
  'tinder':                        { priority: '0.8', changefreq: 'monthly' },
  'bumble':                        { priority: '0.8', changefreq: 'monthly' },
  'hinge':                         { priority: '0.8', changefreq: 'monthly' },
  'best-deepfake-detector':        { priority: '0.8', changefreq: 'monthly' },
  'online-dating-safety':          { priority: '0.8', changefreq: 'monthly' },
  'how-to-spot-ai-generated-images': { priority: '0.8', changefreq: 'monthly' },
  'romance-scam-warning-signs':    { priority: '0.8', changefreq: 'monthly' },
  'ai-video-detector':             { priority: '0.8', changefreq: 'monthly' },
  'protect-your-parents':          { priority: '0.8', changefreq: 'monthly' },
  'pinterest':                     { priority: '0.7', changefreq: 'monthly' },
  'tiktok':                        { priority: '0.7', changefreq: 'monthly' },
  'ai-art-detector':               { priority: '0.7', changefreq: 'monthly' },
  'what-do-ai-faces-look-like':    { priority: '0.7', changefreq: 'monthly' },
  'blog':                          { priority: '0.7', changefreq: 'weekly' },
  'buy-tokens':                    { priority: '0.6', changefreq: 'monthly' },
  'product-hunt':                  { priority: '0.5', changefreq: 'monthly' },
  'contact':                       { priority: '0.4', changefreq: 'yearly' },
  'account':                       { priority: '0.3', changefreq: 'yearly' },
  'privacy':                       { priority: '0.3', changefreq: 'yearly' },
  'terms':                         { priority: '0.3', changefreq: 'yearly' },
  'refunds':                       { priority: '0.3', changefreq: 'yearly' },
};

// Slugs whose lastmod should be pinned (don't update unless file changes)
const PIN_LASTMOD = new Set(Object.keys(PRIORITY_MAP));

// Parse existing sitemap to preserve lastmod for unchanged pages
function parseExistingSitemap() {
  if (!fs.existsSync(SITEMAP_FILE)) return new Map();
  const content = fs.readFileSync(SITEMAP_FILE, 'utf8');
  const map = new Map();
  const urlPattern = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>[\s\S]*?<\/url>/g;
  let m;
  while ((m = urlPattern.exec(content)) !== null) {
    const url = m[1].trim();
    const lastmod = m[2].trim();
    const slug = url.replace(SITE_BASE, '').replace(/^\//, '');
    map.set(slug, lastmod);
  }
  return map;
}

// Get file's last modified date
function fileLastmod(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString().split('T')[0];
  } catch {
    return TODAY;
  }
}

// Collect all pages to include
function collectPages(existingLastmod) {
  const pages = [];
  const seen = new Set();

  function addHtmlFile(file, baseDir, urlPrefix) {
    const slug = urlPrefix
      ? `${urlPrefix}/${file.replace('.html', '')}`
      : (file === 'index.html' ? '' : file.replace('.html', ''));
    if (seen.has(slug)) return;
    seen.add(slug);

    const filePath = path.join(baseDir, file);
    const priority_entry = PRIORITY_MAP[slug];
    const lastmod = PIN_LASTMOD.has(slug)
      ? (existingLastmod.get(slug) || fileLastmod(filePath))
      : fileLastmod(filePath);

    pages.push({
      url: slug === '' ? `${SITE_BASE}/` : `${SITE_BASE}/${slug}`,
      slug,
      lastmod,
      priority: priority_entry?.priority || '0.7',
      changefreq: priority_entry?.changefreq || 'monthly',
      sortKey: priority_entry ? parseFloat(priority_entry.priority) : 0.7,
    });
  }

  // 1. Root-level HTML files (core pages)
  const rootFiles = fs.readdirSync(SITE_ROOT).filter(f => f.endsWith('.html'));
  for (const file of rootFiles) addHtmlFile(file, SITE_ROOT, null);

  // 2. pages/ directory (all generated landing pages — served at root URL via Vercel rewrites)
  const pagesDir = path.join(SITE_ROOT, 'pages');
  if (fs.existsSync(pagesDir)) {
    const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.html'));
    for (const file of pageFiles) addHtmlFile(file, pagesDir, null);
  }

  // 2. Blog posts
  const blogDir = path.join(SITE_ROOT, 'blog');
  if (fs.existsSync(blogDir)) {
    const blogFiles = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
    for (const file of blogFiles) {
      const slug = `blog/${file.replace('.html', '')}`;
      const filePath = path.join(blogDir, file);
      const lastmod = existingLastmod.get(slug) || fileLastmod(filePath);
      pages.push({
        url: `${SITE_BASE}/${slug}`,
        slug,
        lastmod,
        priority: '0.7',
        changefreq: 'monthly',
        sortKey: 0.7,
      });
    }
  }

  return pages;
}

function buildSitemap(pages) {
  // Sort: by priority desc, then slug asc
  pages.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
    return a.slug.localeCompare(b.slug);
  });

  const entries = pages.map(p => `  <url>
    <loc>${p.url}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function main() {
  console.log('🗺  Updating sitemap.xml...');
  const existingLastmod = parseExistingSitemap();
  const pages = collectPages(existingLastmod);

  const newSitemap = buildSitemap(pages);
  fs.writeFileSync(SITEMAP_FILE, newSitemap, 'utf8');

  // Stats
  const byType = {
    'priority 1.0': pages.filter(p => p.priority === '1.0').length,
    'priority 0.8+': pages.filter(p => parseFloat(p.priority) >= 0.8).length,
    'blog': pages.filter(p => p.slug.startsWith('blog/')).length,
    'state': pages.filter(p => p.slug.startsWith('romance-scam-') || p.slug.startsWith('catfish-detector-')).length,
    'total': pages.length,
  };

  console.log(`✅ sitemap.xml updated — ${pages.length} URLs`);
  console.log(`   Blog posts: ${byType.blog}, State pages: ${byType.state}, Core pages: ${byType['priority 0.8+']}`);
}

// Run directly or imported (generate-landing-pages.js calls this as a module)
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
} else {
  main();
}
