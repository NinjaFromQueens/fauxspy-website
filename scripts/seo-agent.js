/**
 * Faux Spy SEO Agent
 * Audits all HTML pages for technical SEO issues and content quality.
 * Outputs seo-results.json for use by seo-report.js.
 *
 * Usage: node scripts/seo-agent.js
 * Requires: ANTHROPIC_API_KEY env var
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const SITE_ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://fauxspy.com';

// Skip these entirely — internal/legal/utility pages
const SKIP_FILES = new Set([
  'admin.html', 'success.html', 'account.html',
  'privacy.html', 'terms.html', 'refunds.html'
]);

// Run technical checks only, no content quality API call
const SKIP_CONTENT = new Set([
  'buy-tokens.html', 'contact.html', 'faq.html', 'pro.html'
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCanonicalUrl(rel) {
  const noExt = rel.replace(/\.html$/, '');
  if (noExt === 'index') return BASE_URL + '/';
  if (noExt === 'blog/index') return BASE_URL + '/blog';
  return BASE_URL + '/' + noExt;
}

function getHtmlFiles() {
  const files = [];

  fs.readdirSync(SITE_ROOT)
    .filter(f => f.endsWith('.html') && !SKIP_FILES.has(f))
    .forEach(f => files.push({ absPath: path.join(SITE_ROOT, f), rel: f }));

  const blogDir = path.join(SITE_ROOT, 'blog');
  if (fs.existsSync(blogDir)) {
    fs.readdirSync(blogDir)
      .filter(f => f.endsWith('.html'))
      .forEach(f => files.push({ absPath: path.join(blogDir, f), rel: `blog/${f}` }));
  }

  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Technical Audit ─────────────────────────────────────────────────────────

function auditTechnical($, rel) {
  const issues = [];
  const expectedUrl = getCanonicalUrl(rel);
  const filename = path.basename(rel);

  // Title
  const title = $('title').first().text().trim();
  if (!title) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-title', detail: 'No <title> tag found.', autoFix: null });
  } else if (title.length < 30) {
    issues.push({ severity: 'WARNING', rule: 'title-too-short', detail: `Title is ${title.length} chars (min 30): "${title}"`, autoFix: null });
  } else if (title.length > 70) {
    issues.push({ severity: 'WARNING', rule: 'title-too-long', detail: `Title is ${title.length} chars (max 70): "${title}"`, autoFix: null });
  }

  // Meta description
  const desc = $('meta[name="description"]').attr('content') || '';
  if (!desc) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-meta-description', detail: 'No meta description found.', autoFix: null });
  } else if (desc.length < 80) {
    issues.push({ severity: 'WARNING', rule: 'meta-description-too-short', detail: `Meta description is ${desc.length} chars (recommended 120–160).`, autoFix: null });
  } else if (desc.length > 165) {
    issues.push({ severity: 'WARNING', rule: 'meta-description-too-long', detail: `Meta description is ${desc.length} chars (max 165, will be cut in SERPs).`, autoFix: { type: 'truncate-meta-desc', current: desc } });
  }

  // Canonical
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  if (!canonical) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-canonical', detail: `No canonical link tag. Expected: ${expectedUrl}`, autoFix: { type: 'add-canonical', value: expectedUrl } });
  } else if (canonical !== expectedUrl) {
    issues.push({ severity: 'WARNING', rule: 'canonical-mismatch', detail: `Canonical "${canonical}" should be "${expectedUrl}"`, autoFix: null });
  }

  // Open Graph
  for (const prop of ['og:title', 'og:description', 'og:image', 'og:url']) {
    const val = $(`meta[property="${prop}"]`).attr('content');
    if (!val) {
      const fix = prop === 'og:url' ? { type: 'add-og-url', value: expectedUrl } : null;
      issues.push({ severity: 'WARNING', rule: `missing-${prop.replace(':', '-')}`, detail: `Missing <meta property="${prop}">.`, autoFix: fix });
    }
  }

  // Twitter card
  if (!$('meta[name="twitter:card"]').attr('content')) {
    issues.push({ severity: 'INFO', rule: 'missing-twitter-card', detail: 'No twitter:card meta tag.', autoFix: null });
  }

  // Robots noindex
  const robots = $('meta[name="robots"]').attr('content') || '';
  if (robots.toLowerCase().includes('noindex')) {
    issues.push({ severity: 'CRITICAL', rule: 'noindex-set', detail: `Page is set to noindex: "${robots}" — remove this or Google will not index it.`, autoFix: null });
  }

  // H1 count
  const h1Count = $('h1').length;
  if (h1Count === 0) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-h1', detail: 'No <h1> tag found.', autoFix: null });
  } else if (h1Count > 1) {
    issues.push({ severity: 'WARNING', rule: 'multiple-h1', detail: `${h1Count} H1 tags found — use exactly one per page.`, autoFix: null });
  }

  // JSON-LD
  const utilityPages = new Set(['index.html', 'pro.html', 'buy-tokens.html', 'contact.html', 'account.html', 'faq.html', 'blog/index.html']);
  const jsonldBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonldBlocks.push(JSON.parse($(el).text())); } catch {}
  });

  if (jsonldBlocks.length === 0 && !utilityPages.has(rel)) {
    issues.push({ severity: 'WARNING', rule: 'missing-schema', detail: 'No JSON-LD structured data found on a content page.', autoFix: null });
  }

  jsonldBlocks.forEach(schema => {
    if (schema['@type'] === 'Article') {
      if (!schema.datePublished) issues.push({ severity: 'WARNING', rule: 'schema-missing-datepublished', detail: 'Article schema is missing datePublished.', autoFix: null });
      if (!schema.author) issues.push({ severity: 'WARNING', rule: 'schema-missing-author', detail: 'Article schema is missing author.', autoFix: null });
      if (!schema.publisher) issues.push({ severity: 'INFO', rule: 'schema-missing-publisher', detail: 'Article schema is missing publisher.', autoFix: null });
    }
    if (schema['@type'] === 'FAQPage' && !schema.mainEntity) {
      issues.push({ severity: 'WARNING', rule: 'schema-missing-mainentity', detail: 'FAQPage schema is missing mainEntity.', autoFix: null });
    }
  });

  // Images missing alt
  let missingAlt = 0;
  $('img').each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined) missingAlt++;
  });
  if (missingAlt > 0) {
    issues.push({ severity: 'WARNING', rule: 'img-missing-alt', detail: `${missingAlt} <img> tag(s) missing alt attribute.`, autoFix: { type: 'add-empty-alt', count: missingAlt } });
  }

  // Internal .html links
  let htmlLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/') && href.endsWith('.html')) htmlLinks++;
  });
  if (htmlLinks > 0) {
    issues.push({ severity: 'WARNING', rule: 'html-extension-links', detail: `${htmlLinks} internal link(s) still use .html extensions. cleanUrls is active — use /page not /page.html.`, autoFix: { type: 'strip-html-links', count: htmlLinks } });
  }

  return { issues, title };
}

// ─── Content Quality Audit (Claude) ──────────────────────────────────────────

async function auditContent($, rel, title) {
  const h2s = [];
  $('h2').each((_, el) => h2s.push($(el).text().trim()));

  // Pull meaningful text from content containers, skip nav/footer boilerplate
  const contentSelectors = [
    'article', 'main', '.landing-section', '.blog-content',
    '.container > p', 'h1', 'h2', 'h3'
  ];
  let bodyText = '';
  $(contentSelectors.join(', ')).each((_, el) => {
    bodyText += ' ' + $(el).text();
  });
  bodyText = bodyText.replace(/\s+/g, ' ').trim().slice(0, 4000);

  if (bodyText.length < 150) return [];

  const prompt = `You are a senior SEO content auditor applying Google's current quality standards: E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness), Helpful Content guidelines, and spam policies.

Page title: "${title}"
URL: ${getCanonicalUrl(rel)}
H2 headings: ${h2s.slice(0, 12).join(' | ') || 'none found'}

Content (first 4000 chars):
---
${bodyText}
---

Audit this page for SEO content quality. Return a JSON array of issues. Each issue must be:
{"severity":"CRITICAL"|"WARNING"|"INFO","rule":"kebab-case-rule-name","detail":"specific, actionable explanation of the problem"}

Check for:
1. AI writing patterns — generic phrasing, filler sentences, unnatural cadence, lists of vague points (this site is penalized if Google detects AI copy)
2. Keyword/topic mismatch — does the title promise something the body doesn't deliver?
3. Thin or low-value content — repeats obvious points, no real information, padded length
4. Missing E-E-A-T signals — no specific data, no first-hand perspective, no expertise markers
5. Outdated references — statistics, dates, or claims that appear to be older than 12 months
6. Heading structure problems — H2s not logically organized for the topic, keyword stuffing in headings
7. Duplicate content risk — overly generic copy that could match dozens of competitor pages

Return ONLY a valid JSON array. Return [] if no issues. No markdown fences, no explanation.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content[0]?.text?.trim() || '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`    ⚠️  Content audit API error for ${rel}: ${e.message}`);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required.');
    process.exit(1);
  }

  console.log('🔍 Faux Spy SEO Agent\n');

  const files = getHtmlFiles();
  console.log(`Found ${files.length} pages to audit\n`);

  const results = [];
  const totals = { CRITICAL: 0, WARNING: 0, INFO: 0 };

  for (const { absPath, rel } of files) {
    process.stdout.write(`  ${rel.padEnd(48)}`);

    const rawHtml = fs.readFileSync(absPath, 'utf8');
    const $ = cheerio.load(rawHtml);

    const { issues: techIssues, title } = auditTechnical($, rel);

    const skipContent = SKIP_CONTENT.has(path.basename(rel));
    const contentIssues = skipContent ? [] : await auditContent($, rel, title);

    const allIssues = [...techIssues, ...contentIssues];
    allIssues.forEach(i => { totals[i.severity] = (totals[i.severity] || 0) + 1; });

    const c = allIssues.filter(i => i.severity === 'CRITICAL').length;
    const w = allIssues.filter(i => i.severity === 'WARNING').length;
    const icon = c > 0 ? '🔴' : w > 0 ? '🟡' : '✅';
    console.log(`${icon}  ${c}C ${w}W`);

    results.push({ file: rel, url: getCanonicalUrl(rel), title, issues: allIssues });

    if (!skipContent) await sleep(800);
  }

  fs.writeFileSync(path.join(SITE_ROOT, 'seo-results.json'), JSON.stringify(results, null, 2));

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Total: ${files.length} pages audited`);
  console.log(`🔴 Critical: ${totals.CRITICAL}  🟡 Warning: ${totals.WARNING}  ℹ️  Info: ${totals.INFO}`);
  console.log(`Results saved to seo-results.json`);

  // Export totals for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const hasFixes = results.some(r => r.issues.some(i => i.autoFix));
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `critical=${totals.CRITICAL}\nwarnings=${totals.WARNING}\ninfo=${totals.INFO}\nhas_fixes=${hasFixes}\n`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
