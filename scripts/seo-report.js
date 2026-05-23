/**
 * Faux Spy SEO Report Generator + Auto-Fixer
 * Reads seo-results.json, generates a markdown report, and applies safe technical fixes.
 *
 * Usage: node scripts/seo-report.js
 * Run after: node scripts/seo-agent.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..');
const RESULTS_FILE = path.join(SITE_ROOT, 'seo-results.json');
const REPORT_FILE = path.join(SITE_ROOT, 'seo-report.md');
const FIXES_SUMMARY_FILE = path.join(SITE_ROOT, 'seo-fixes-summary.md');
const SITEMAP_FILE = path.join(SITE_ROOT, 'sitemap.xml');
const INDEXNOW_FILE = path.join(SITE_ROOT, '.github', 'workflows', 'indexnow.yml');
const SITE_BASE = 'https://fauxspy.com';

// Pages that should never be auto-added to the sitemap
const SITEMAP_EXCLUDE = new Set(['admin', 'success', 'account', 'privacy', 'terms', 'refunds']);

if (!fs.existsSync(RESULTS_FILE)) {
  console.error('❌ seo-results.json not found. Run seo-agent.js first.');
  process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
// Support both old flat-array format and new { results, competitorGaps } format
const pageResults = Array.isArray(rawData) ? rawData : (rawData.results || []);
const competitorGaps = Array.isArray(rawData) ? null : (rawData.competitorGaps || null);

// ─── Report Generator ─────────────────────────────────────────────────────────

function buildReport(results, fixesMade, sitemapAdded, gapData) {
  const today = new Date().toISOString().split('T')[0];
  const totalPages = results.length;
  const allIssues = results.flatMap(r => r.issues);
  const critical = allIssues.filter(i => i.severity === 'CRITICAL').length;
  const warnings = allIssues.filter(i => i.severity === 'WARNING').length;
  const info = allIssues.filter(i => i.severity === 'INFO').length;
  const clean = results.filter(r => r.issues.length === 0).length;

  let md = `# SEO Audit Report — ${today}\n\n`;
  md += `**${totalPages} pages audited** · 🔴 ${critical} critical · 🟡 ${warnings} warnings · ℹ️ ${info} info · ✅ ${clean} clean\n\n`;

  if (fixesMade.length > 0) {
    md += `> **Auto-fixes applied:** ${fixesMade.length} technical issue(s) were fixed automatically and are included in this PR.\n\n`;
  }

  if (sitemapAdded && sitemapAdded.length > 0) {
    md += `> **Sitemap sync:** ${sitemapAdded.length} page(s) added to sitemap.xml and indexnow.yml.\n\n`;
  }

  // Summary table
  md += `## Summary\n\n`;
  md += `| Page | Critical | Warnings | Info |\n`;
  md += `|------|----------|----------|------|\n`;
  const sorted = [...results].sort((a, b) => {
    const aC = a.issues.filter(i => i.severity === 'CRITICAL').length;
    const bC = b.issues.filter(i => i.severity === 'CRITICAL').length;
    return bC - aC || b.issues.filter(i => i.severity === 'WARNING').length - a.issues.filter(i => i.severity === 'WARNING').length;
  });
  sorted.forEach(r => {
    const c = r.issues.filter(i => i.severity === 'CRITICAL').length;
    const w = r.issues.filter(i => i.severity === 'WARNING').length;
    const n = r.issues.filter(i => i.severity === 'INFO').length;
    const icon = c > 0 ? '🔴' : w > 0 ? '🟡' : '✅';
    md += `| ${icon} [${r.file}](${r.url}) | ${c || '—'} | ${w || '—'} | ${n || '—'} |\n`;
  });

  // Per-page details (only pages with issues)
  const withIssues = sorted.filter(r => r.issues.length > 0);
  if (withIssues.length > 0) {
    md += `\n## Issues by Page\n\n`;
    withIssues.forEach(r => {
      md += `### ${r.file}\n`;
      md += `URL: ${r.url}\n\n`;

      // PageSpeed summary if present
      if (r.pageSpeed) {
        const ps = r.pageSpeed;
        const emoji = ps.score >= 70 ? '🟢' : ps.score >= 50 ? '🟡' : '🔴';
        md += `**PageSpeed (mobile):** ${emoji} ${ps.score}/100`;
        if (ps.lcp) md += ` · LCP ${ps.lcp}`;
        if (ps.cls !== undefined) md += ` · CLS ${ps.cls}`;
        md += '\n\n';
      }

      for (const sev of ['CRITICAL', 'WARNING', 'INFO']) {
        const group = r.issues.filter(i => i.severity === sev);
        if (group.length === 0) continue;
        const icon = sev === 'CRITICAL' ? '🔴' : sev === 'WARNING' ? '🟡' : 'ℹ️';
        group.forEach(issue => {
          const fixNote = issue.autoFix ? ' *(auto-fixed)*' : '';
          md += `- ${icon} **${issue.rule}**${fixNote}: ${issue.detail}\n`;
        });
      }
      md += '\n';
    });
  }

  // Content gaps from competitor analysis
  if (gapData && gapData.length > 0) {
    md += `## Content Gaps vs. Competitors\n\n`;
    md += `Topics your competitors cover that Faux Spy pages are missing:\n\n`;
    gapData.forEach(gap => {
      md += `### ${gap.page}\n`;
      md += `**Target keyword:** ${gap.keyword}\n\n`;
      if (gap.gaps && gap.gaps.length > 0) {
        gap.gaps.forEach(g => { md += `- ${g}\n`; });
      } else if (gap.summary) {
        md += gap.summary + '\n';
      }
      md += '\n';
    });
  }

  // What to do next (content issues that need human attention)
  const contentIssues = allIssues.filter(i =>
    ['ai-writing-patterns', 'thin-content', 'missing-eeat', 'outdated-claims',
     'keyword-mismatch', 'duplicate-content-risk', 'heading-structure'].some(k =>
      i.rule.includes(k) || i.rule.includes('content') || i.rule.includes('eeat') || i.rule.includes('ai-')
    )
  );
  if (contentIssues.length > 0) {
    md += `## Content Issues Requiring Manual Review\n\n`;
    md += `These cannot be auto-fixed — they need human rewriting:\n\n`;
    contentIssues.forEach(i => {
      const page = results.find(r => r.issues.includes(i));
      md += `- **${page?.file}** — ${i.rule}: ${i.detail}\n`;
    });
    md += '\n';
  }

  md += `---\n*Generated by Faux Spy SEO Agent · ${today}*\n`;
  return md;
}

// ─── Auto-Fixer ───────────────────────────────────────────────────────────────

function truncateAtWordBoundary(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(' ', maxLen - 3);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxLen - 3)) + '...';
}

function applyFixes(results) {
  const fixLog = [];

  results.forEach(r => {
    const fixable = r.issues.filter(i => i.autoFix);
    if (fixable.length === 0) return;

    const absPath = path.join(SITE_ROOT, r.file);
    if (!fs.existsSync(absPath)) return;

    let html = fs.readFileSync(absPath, 'utf8');
    let changed = false;

    fixable.forEach(issue => {
      const { type, value, current } = issue.autoFix;

      if (type === 'add-canonical') {
        if (!html.includes('rel="canonical"')) {
          html = html.replace('</head>', `  <link rel="canonical" href="${value}">\n</head>`);
          fixLog.push({ file: r.file, rule: issue.rule, detail: `Added canonical: ${value}` });
          changed = true;
        }
      }

      if (type === 'add-og-url') {
        if (!html.includes('og:url')) {
          html = html.replace('</head>', `  <meta property="og:url" content="${value}">\n</head>`);
          fixLog.push({ file: r.file, rule: issue.rule, detail: `Added og:url: ${value}` });
          changed = true;
        }
      }

      if (type === 'truncate-meta-desc' && current) {
        const truncated = truncateAtWordBoundary(current, 160);
        if (truncated !== current) {
          const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const newHtml = html.replace(
            new RegExp(`(meta name="description" content=")${escaped}(")`),
            `$1${truncated}$2`
          );
          if (newHtml !== html) {
            html = newHtml;
            fixLog.push({ file: r.file, rule: issue.rule, detail: `Truncated meta description to ${truncated.length} chars` });
            changed = true;
          }
        }
      }

      if (type === 'strip-html-links') {
        const before = html;
        html = html.replace(/href="(\/[^"]*?)\.html"/g, 'href="$1"');
        if (html !== before) {
          fixLog.push({ file: r.file, rule: issue.rule, detail: `Removed .html extensions from internal links` });
          changed = true;
        }
      }

      if (type === 'add-empty-alt') {
        const before = html;
        html = html.replace(/<img(?![^>]*\balt=)([^>]*)>/gi, '<img$1 alt="">');
        if (html !== before) {
          fixLog.push({ file: r.file, rule: issue.rule, detail: `Added alt="" to img tags missing alt attribute` });
          changed = true;
        }
      }

      // D — inject Claude-generated meta description
      if (type === 'generated-meta-desc' && value) {
        const safeValue = value.replace(/"/g, '&quot;');
        if (current) {
          // Replace existing short/missing description
          const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const newHtml = html.replace(
            new RegExp(`(<meta\\s+name="description"\\s+content=")${escaped}(")`),
            `$1${safeValue}$2`
          );
          if (newHtml !== html) {
            html = newHtml;
            fixLog.push({ file: r.file, rule: issue.rule, detail: `Replaced short meta description with generated text (${safeValue.length} chars)` });
            changed = true;
          }
        } else if (!html.includes('name="description"')) {
          html = html.replace('</head>', `  <meta name="description" content="${safeValue}">\n</head>`);
          fixLog.push({ file: r.file, rule: issue.rule, detail: `Inserted generated meta description (${safeValue.length} chars)` });
          changed = true;
        }
      }
    });

    if (changed) {
      fs.writeFileSync(absPath, html, 'utf8');
      console.log(`  ✏️  Fixed ${r.file} (${fixable.length} issue(s))`);
    }
  });

  return fixLog;
}

// ─── Sitemap Validator + Auto-Sync (C) ────────────────────────────────────────

function validateAndFixSitemap(results) {
  if (!fs.existsSync(SITEMAP_FILE)) {
    console.log('  ⚠️  sitemap.xml not found — skipping sitemap sync');
    return [];
  }

  const today = new Date().toISOString().split('T')[0];
  let sitemapXml = fs.readFileSync(SITEMAP_FILE, 'utf8');

  // Extract URLs already in sitemap
  const existingLocs = new Set(
    [...sitemapXml.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)].map(m => m[1].trim())
  );

  const added = [];

  results.forEach(r => {
    // Convert file path to canonical URL slug
    let slug = r.file.replace(/\\/g, '/').replace(/\.html$/, '');
    if (slug === 'index') slug = '';

    // Skip excluded pages
    const baseName = slug.split('/').pop();
    if (SITEMAP_EXCLUDE.has(baseName)) return;

    const canonical = slug === '' ? `${SITE_BASE}/` : `${SITE_BASE}/${slug}`;

    if (!existingLocs.has(canonical)) {
      const block = `  <url>\n    <loc>${canonical}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
      sitemapXml = sitemapXml.replace('</urlset>', block + '</urlset>');
      existingLocs.add(canonical);
      added.push(canonical);
      console.log(`  🗺️  Added to sitemap: ${canonical}`);
    }
  });

  if (added.length > 0) {
    fs.writeFileSync(SITEMAP_FILE, sitemapXml, 'utf8');

    // Sync indexnow.yml
    if (fs.existsSync(INDEXNOW_FILE)) {
      let indexNow = fs.readFileSync(INDEXNOW_FILE, 'utf8');
      let indexNowChanged = false;

      added.forEach(url => {
        if (!indexNow.includes(`"${url}"`)) {
          // Insert new URL before the closing ] of urlList
          // The ] sits on its own line indented 14 spaces inside the JSON body
          const closeIdx = indexNow.lastIndexOf('\n              ]');
          if (closeIdx !== -1) {
            indexNow =
              indexNow.slice(0, closeIdx) +
              `,\n                "${url}"` +
              indexNow.slice(closeIdx);
            indexNowChanged = true;
            console.log(`  📡  Added to indexnow.yml: ${url}`);
          }
        }
      });

      if (indexNowChanged) {
        fs.writeFileSync(INDEXNOW_FILE, indexNow, 'utf8');
      }
    }
  }

  return added;
}

// ─── Fixes Summary ────────────────────────────────────────────────────────────

function buildFixesSummary(fixLog, sitemapAdded) {
  const today = new Date().toISOString().split('T')[0];
  const total = fixLog.length + (sitemapAdded ? sitemapAdded.length : 0);
  let md = `# SEO Auto-Fixes — ${today}\n\n`;
  md += `${total} issue(s) were automatically fixed:\n\n`;

  if (fixLog.length > 0) {
    const byFile = {};
    fixLog.forEach(f => {
      if (!byFile[f.file]) byFile[f.file] = [];
      byFile[f.file].push(f);
    });

    Object.entries(byFile).forEach(([file, fixes]) => {
      md += `### ${file}\n`;
      fixes.forEach(f => { md += `- \`${f.rule}\`: ${f.detail}\n`; });
      md += '\n';
    });
  }

  if (sitemapAdded && sitemapAdded.length > 0) {
    md += `### sitemap.xml + indexnow.yml\n`;
    sitemapAdded.forEach(url => { md += `- Added missing URL: ${url}\n`; });
    md += '\n';
  }

  md += `---\n*Applied by Faux Spy SEO Agent · ${today}*\n`;
  return md;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('📝 Faux Spy SEO Report Generator\n');

console.log('Applying auto-fixes...');
const fixLog = applyFixes(pageResults);
console.log(`  ${fixLog.length} fix(es) applied\n`);

console.log('Validating sitemap...');
const sitemapAdded = validateAndFixSitemap(pageResults);
console.log(`  ${sitemapAdded.length} URL(s) added to sitemap\n`);

console.log('Building report...');
const report = buildReport(pageResults, fixLog, sitemapAdded, competitorGaps);
fs.writeFileSync(REPORT_FILE, report, 'utf8');
console.log(`  Report saved to seo-report.md`);

const totalFixes = fixLog.length + sitemapAdded.length;
if (totalFixes > 0) {
  const summary = buildFixesSummary(fixLog, sitemapAdded);
  fs.writeFileSync(FIXES_SUMMARY_FILE, summary, 'utf8');
  console.log(`  Fixes summary saved to seo-fixes-summary.md`);
}

// Export for GitHub Actions
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_fixes=${totalFixes > 0}\n`);
}

console.log('\nDone.');
