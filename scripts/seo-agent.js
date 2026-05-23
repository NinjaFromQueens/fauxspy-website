/**
 * Faux Spy SEO Agent — Full Audit Suite
 *
 * Capabilities:
 *   Technical checks: title, meta desc, canonical, OG tags, H1, schema, alt, .html links
 *   B — Duplicate title/description detector
 *   A — Broken internal link checker
 *   D — Auto-generate missing meta descriptions via Claude
 *   E — PageSpeed Insights (Core Web Vitals) for top pages
 *   H — Competitor content gap analysis via Claude
 *   Content quality: AI writing patterns, E-E-A-T, thin content, outdated claims
 *
 * Usage: node scripts/seo-agent.js
 * Requires: ANTHROPIC_API_KEY env var
 */

'use strict';

const { default: Anthropic } = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SITE_ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://fauxspy.com';

const SKIP_FILES = new Set([
  'admin.html', 'success.html', 'account.html',
  'privacy.html', 'terms.html', 'refunds.html'
]);

const SKIP_CONTENT = new Set([
  'buy-tokens.html', 'contact.html', 'faq.html', 'pro.html'
]);

// Top pages to run PageSpeed on (E) — pick the most traffic-important ones
const PAGESPEED_PAGES = new Set([
  'index.html', 'deepfake-detector.html', 'catfish-detector.html',
  'ai-video-detector.html', 'ai-art-detector.html', 'best-deepfake-detector.html',
  'dating-apps.html', 'tinder.html', 'instagram.html', 'how-to-spot-ai-generated-images.html'
]);

// Competitor pages for gap analysis (H) — update as needed
const COMPETITOR_MAP = {
  'deepfake-detector': {
    keyword: 'deepfake detector Chrome extension',
    ourH2s: [],
    competitors: [
      'https://sensity.ai/deepfake-detection/',
      'https://isitai.com'
    ]
  },
  'catfish-detector': {
    keyword: 'catfish detector online tool',
    ourH2s: [],
    competitors: [
      'https://www.socialcatfish.com/blog/how-to-find-a-catfish/'
    ]
  },
  'ai-video-detector': {
    keyword: 'AI generated video detector',
    ourH2s: [],
    competitors: [
      'https://sensity.ai/deepfake-video-detection/'
    ]
  },
  'how-to-spot-ai-generated-images': {
    keyword: 'how to spot AI generated images',
    ourH2s: [],
    competitors: [
      'https://www.adobe.com/creativecloud/photography/hub/guides/how-to-tell-if-a-photo-is-ai-generated.html'
    ]
  }
};

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractBodyText($) {
  const selectors = ['article', 'main', '.landing-section', '.container > p', 'h1', 'h2', 'h3'];
  let text = '';
  $(selectors.join(', ')).each((_, el) => { text += ' ' + $(el).text(); });
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Technical Audit ─────────────────────────────────────────────────────────

function auditTechnical($, rel) {
  const issues = [];
  const expectedUrl = getCanonicalUrl(rel);

  const title = $('title').first().text().trim();
  if (!title) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-title', detail: 'No <title> tag found.', autoFix: null });
  } else if (title.length < 30) {
    issues.push({ severity: 'WARNING', rule: 'title-too-short', detail: `Title is ${title.length} chars (min 30): "${title}"`, autoFix: null });
  } else if (title.length > 70) {
    issues.push({ severity: 'WARNING', rule: 'title-too-long', detail: `Title is ${title.length} chars (max 70): "${title}"`, autoFix: null });
  }

  const desc = $('meta[name="description"]').attr('content') || '';
  if (!desc) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-meta-description', detail: 'No meta description found.', autoFix: null });
  } else if (desc.length < 80) {
    issues.push({ severity: 'WARNING', rule: 'meta-description-too-short', detail: `Meta description is ${desc.length} chars (recommended 120–160).`, autoFix: null });
  } else if (desc.length > 165) {
    issues.push({ severity: 'WARNING', rule: 'meta-description-too-long', detail: `Meta description is ${desc.length} chars (max 165).`, autoFix: { type: 'truncate-meta-desc', current: desc } });
  }

  const canonical = $('link[rel="canonical"]').attr('href') || '';
  if (!canonical) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-canonical', detail: `No canonical link. Expected: ${expectedUrl}`, autoFix: { type: 'add-canonical', value: expectedUrl } });
  } else if (canonical !== expectedUrl) {
    issues.push({ severity: 'WARNING', rule: 'canonical-mismatch', detail: `Canonical "${canonical}" should be "${expectedUrl}"`, autoFix: null });
  }

  for (const prop of ['og:title', 'og:description', 'og:image', 'og:url']) {
    if (!$(`meta[property="${prop}"]`).attr('content')) {
      const fix = prop === 'og:url' ? { type: 'add-og-url', value: expectedUrl } : null;
      issues.push({ severity: 'WARNING', rule: `missing-${prop.replace(':', '-')}`, detail: `Missing <meta property="${prop}">.`, autoFix: fix });
    }
  }

  if (!$('meta[name="twitter:card"]').attr('content')) {
    issues.push({ severity: 'INFO', rule: 'missing-twitter-card', detail: 'No twitter:card meta tag.', autoFix: null });
  }

  const robots = $('meta[name="robots"]').attr('content') || '';
  if (robots.toLowerCase().includes('noindex')) {
    issues.push({ severity: 'CRITICAL', rule: 'noindex-set', detail: `Page is noindex: "${robots}"`, autoFix: null });
  }

  const h1Count = $('h1').length;
  if (h1Count === 0) {
    issues.push({ severity: 'CRITICAL', rule: 'missing-h1', detail: 'No <h1> tag found.', autoFix: null });
  } else if (h1Count > 1) {
    issues.push({ severity: 'WARNING', rule: 'multiple-h1', detail: `${h1Count} H1 tags found — use exactly one.`, autoFix: null });
  }

  const utilityPages = new Set(['index.html', 'pro.html', 'buy-tokens.html', 'contact.html', 'account.html', 'faq.html', 'blog/index.html']);
  const jsonldBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonldBlocks.push(JSON.parse($(el).text())); } catch {}
  });
  if (jsonldBlocks.length === 0 && !utilityPages.has(rel)) {
    issues.push({ severity: 'WARNING', rule: 'missing-schema', detail: 'No JSON-LD structured data on content page.', autoFix: null });
  }
  jsonldBlocks.forEach(schema => {
    if (schema['@type'] === 'Article') {
      if (!schema.datePublished) issues.push({ severity: 'WARNING', rule: 'schema-missing-datepublished', detail: 'Article schema missing datePublished.', autoFix: null });
      if (!schema.author) issues.push({ severity: 'WARNING', rule: 'schema-missing-author', detail: 'Article schema missing author.', autoFix: null });
    }
    if (schema['@type'] === 'FAQPage' && !schema.mainEntity) {
      issues.push({ severity: 'WARNING', rule: 'schema-missing-mainentity', detail: 'FAQPage schema missing mainEntity.', autoFix: null });
    }
  });

  let missingAlt = 0;
  $('img').each((_, el) => { if ($(el).attr('alt') === undefined) missingAlt++; });
  if (missingAlt > 0) {
    issues.push({ severity: 'WARNING', rule: 'img-missing-alt', detail: `${missingAlt} <img> tag(s) missing alt attribute.`, autoFix: { type: 'add-empty-alt', count: missingAlt } });
  }

  let htmlLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/') && href.endsWith('.html')) htmlLinks++;
  });
  if (htmlLinks > 0) {
    issues.push({ severity: 'WARNING', rule: 'html-extension-links', detail: `${htmlLinks} link(s) use .html extensions (cleanUrls is active).`, autoFix: { type: 'strip-html-links', count: htmlLinks } });
  }

  return { issues, title, desc };
}

// ─── Content Quality Audit (Claude) ──────────────────────────────────────────

async function auditContent($, rel, title) {
  const h2s = [];
  $('h2').each((_, el) => h2s.push($(el).text().trim()));
  const bodyText = extractBodyText($).slice(0, 4000);
  if (bodyText.length < 150) return [];

  const prompt = `You are a senior SEO content auditor applying Google's current quality standards: E-E-A-T, Helpful Content guidelines, and spam policies.

Page title: "${title}"
URL: ${getCanonicalUrl(rel)}
H2 headings: ${h2s.slice(0, 12).join(' | ') || 'none'}

Content (first 4000 chars):
---
${bodyText}
---

Return a JSON array of issues found. Each: {"severity":"CRITICAL"|"WARNING"|"INFO","rule":"kebab-case","detail":"specific, actionable explanation"}

Check for:
1. AI writing patterns — generic phrasing, filler, unnatural cadence (site is penalized if Google detects AI copy)
2. Keyword/topic mismatch — title promises something the body doesn't deliver
3. Thin content — repeats obvious points, no real information
4. Missing E-E-A-T — no specific data, no first-hand perspective, no expertise markers
5. Outdated references — statistics or dates appearing older than 12 months
6. Heading structure issues — H2s not logically organized, keyword stuffing
7. Duplicate content risk — overly generic copy matching dozens of competitor pages

Return ONLY valid JSON array. Return [] if no issues. No markdown, no explanation.`;

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
    console.error(`    ⚠️  Content audit error for ${rel}: ${e.message}`);
    return [];
  }
}

// ─── D: Auto-generate Meta Descriptions ──────────────────────────────────────

async function generateMetaDesc(title, $) {
  const bodyText = extractBodyText($).slice(0, 1500);
  if (bodyText.length < 100) return null;

  const prompt = `Write a single meta description for this web page. It must:
- Be 130–155 characters long (count carefully)
- Start with an action verb or compelling hook
- Naturally include the page's main keyword
- Sound human and direct, not corporate or AI-generated
- Not use quotes, em-dashes, or markdown
- End with a clear benefit or CTA

Page title: "${title}"
Page content excerpt: "${bodyText.slice(0, 500)}"

Return ONLY the meta description text. No quotes, no labels, no explanation.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = (response.content[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    return text.length >= 100 && text.length <= 165 ? text : null;
  } catch (e) {
    return null;
  }
}

// ─── E: PageSpeed Insights ────────────────────────────────────────────────────

async function checkPageSpeed(url) {
  try {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const data = await res.json();
    const lr = data.lighthouseResult;
    if (!lr) return null;
    return {
      score: Math.round((lr.categories?.performance?.score || 0) * 100),
      lcp: lr.audits?.['largest-contentful-paint']?.displayValue || '—',
      cls: lr.audits?.['cumulative-layout-shift']?.displayValue || '—',
      fcp: lr.audits?.['first-contentful-paint']?.displayValue || '—',
      tbt: lr.audits?.['total-blocking-time']?.displayValue || '—'
    };
  } catch (e) {
    return null;
  }
}

// ─── A: Broken Internal Link Checker ─────────────────────────────────────────

function checkBrokenLinks(results) {
  console.log('\n🔗 Checking internal links...');

  // Build valid path set from all known HTML files
  const validPaths = new Set(['/']);
  results.forEach(r => {
    const noExt = r.file.replace(/\.html$/, '');
    if (noExt === 'index') return;
    if (noExt === 'blog/index') { validPaths.add('/blog'); return; }
    validPaths.add('/' + noExt);
  });
  // Add utility pages not in results (skipped during audit)
  ['/privacy', '/terms', '/refunds', '/account', '/success', '/admin'].forEach(p => validPaths.add(p));

  let totalBroken = 0;

  results.forEach(r => {
    const rawHtml = fs.readFileSync(path.join(SITE_ROOT, r.file), 'utf8');
    const $ = cheerio.load(rawHtml);
    const seenOnPage = new Set();

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').split('?')[0].split('#')[0];
      if (!href.startsWith('/') || href.startsWith('//')) return;
      if (seenOnPage.has(href)) return;
      seenOnPage.add(href);

      const normalized = href.replace(/\.html$/, '').replace(/\/$/, '') || '/';
      if (validPaths.has(normalized) || normalized.startsWith('/api/')) return;

      // Also check if the file literally exists on disk
      const asFile = path.join(SITE_ROOT, normalized.slice(1) + '.html');
      const asIndex = path.join(SITE_ROOT, normalized.slice(1), 'index.html');
      if (fs.existsSync(asFile) || fs.existsSync(asIndex)) return;

      r.issues.push({
        severity: 'CRITICAL',
        rule: 'broken-internal-link',
        detail: `Broken internal link: "${href}"`,
        autoFix: null
      });
      totalBroken++;
    });
  });

  console.log(`  Found ${totalBroken} broken internal link(s) across all pages`);
}

// ─── B: Duplicate Title/Description Detector ─────────────────────────────────

function detectDuplicates(results) {
  console.log('\n🔁 Checking for duplicate titles and descriptions...');

  // Normalize title: strip " | Faux Spy" suffix and lowercase
  const normalize = str => str.toLowerCase()
    .replace(/\s*[|—–-]\s*faux spy.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const titleMap = new Map();
  const descMap = new Map();

  results.forEach(r => {
    const rawHtml = fs.readFileSync(path.join(SITE_ROOT, r.file), 'utf8');
    const $ = cheerio.load(rawHtml);

    const normTitle = normalize($('title').first().text().trim());
    const normDesc = normalize($('meta[name="description"]').attr('content') || '');

    if (normTitle) {
      if (!titleMap.has(normTitle)) titleMap.set(normTitle, []);
      titleMap.get(normTitle).push(r.file);
    }
    if (normDesc && normDesc.length > 30) {
      if (!descMap.has(normDesc)) descMap.set(normDesc, []);
      descMap.get(normDesc).push(r.file);
    }
  });

  let found = 0;

  titleMap.forEach((files, title) => {
    if (files.length < 2) return;
    found++;
    files.forEach(file => {
      const r = results.find(r => r.file === file);
      if (r) r.issues.push({
        severity: 'WARNING',
        rule: 'duplicate-title',
        detail: `Identical title also used by: ${files.filter(f => f !== file).join(', ')}`,
        autoFix: null
      });
    });
  });

  descMap.forEach((files, desc) => {
    if (files.length < 2) return;
    found++;
    files.forEach(file => {
      const r = results.find(r => r.file === file);
      if (r) r.issues.push({
        severity: 'WARNING',
        rule: 'duplicate-meta-description',
        detail: `Same meta description also used by: ${files.filter(f => f !== file).join(', ')}`,
        autoFix: null
      });
    });
  });

  console.log(`  Found ${found} duplicate title/description group(s)`);
}

// ─── H: Competitor Content Gap Analysis ──────────────────────────────────────

async function analyzeCompetitorGaps(results) {
  console.log('\n🏁 Analyzing competitor content gaps...');

  const gaps = [];

  for (const [pageSlug, config] of Object.entries(COMPETITOR_MAP)) {
    const result = results.find(r => r.file === `${pageSlug}.html`);
    if (!result) continue;

    process.stdout.write(`  ${pageSlug}...`);

    // Get our H2s
    const rawHtml = fs.readFileSync(path.join(SITE_ROOT, `${pageSlug}.html`), 'utf8');
    const $ = cheerio.load(rawHtml);
    const ourH2s = [];
    $('h2').each((_, el) => ourH2s.push($(el).text().trim()));

    // Try to fetch competitor headings
    const competitorHeadings = [];
    for (const compUrl of config.competitors) {
      try {
        const res = await fetch(compUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-audit-bot/1.0)' },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const html = await res.text();
          const $c = cheerio.load(html);
          const h2s = [];
          $c('h1, h2, h3').each((_, el) => {
            const t = $c(el).text().trim();
            if (t && t.length > 5) h2s.push(t);
          });
          if (h2s.length > 0) competitorHeadings.push({ url: compUrl, headings: h2s.slice(0, 20) });
        }
      } catch {}
      await sleep(500);
    }

    // Ask Claude to identify gaps
    const competitorContext = competitorHeadings.length > 0
      ? competitorHeadings.map(c => `${c.url}:\n${c.headings.map(h => `  - ${h}`).join('\n')}`).join('\n\n')
      : `No competitor pages could be fetched. Use your knowledge of top-ranking pages for "${config.keyword}".`;

    const prompt = `You are an SEO content strategist. Analyze what topics a competitor page covers that our page is missing.

Keyword target: "${config.keyword}"

Our page headings:
${ourH2s.map(h => `  - ${h}`).join('\n') || '  (none found)'}

Competitor content:
${competitorContext}

Identify 3–5 specific topic angles or sections that top competitors cover for "${config.keyword}" that our page is missing or thin on.
Be specific — name exact topics, not vague suggestions like "add more content".

Return a JSON array: [{"gap":"specific topic","why":"why this matters for ranking","priority":"HIGH"|"MEDIUM"}]
Return ONLY valid JSON. No markdown, no explanation.`;

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0]?.text?.trim() || '[]';
      const match = raw.match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : [];
      if (Array.isArray(parsed) && parsed.length > 0) {
        gaps.push({ page: `${pageSlug}.html`, url: result.url, keyword: config.keyword, gaps: parsed });
        console.log(` ${parsed.length} gap(s) found`);
      } else {
        console.log(' none');
      }
    } catch (e) {
      console.log(` error: ${e.message}`);
    }

    await sleep(1000);
  }

  return gaps;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required.');
    process.exit(1);
  }

  console.log('🔍 Faux Spy SEO Agent — Full Audit\n');

  const files = getHtmlFiles();
  console.log(`Found ${files.length} pages to audit\n`);

  const results = [];
  const totals = { CRITICAL: 0, WARNING: 0, INFO: 0 };

  // ── Phase 1: Per-page audit ────────────────────────────────────────────────
  for (const { absPath, rel } of files) {
    process.stdout.write(`  ${rel.padEnd(48)}`);

    const rawHtml = fs.readFileSync(absPath, 'utf8');
    const $ = cheerio.load(rawHtml);

    const { issues: techIssues, title, desc } = auditTechnical($, rel);

    const skipContent = SKIP_CONTENT.has(path.basename(rel));
    const contentIssues = skipContent ? [] : await auditContent($, rel, title);

    // D: Auto-generate meta description if missing or too short
    const needsMeta = techIssues.some(i =>
      i.rule === 'missing-meta-description' || i.rule === 'meta-description-too-short'
    );
    if (!skipContent && needsMeta) {
      const generated = await generateMetaDesc(title, $);
      if (generated) {
        const metaIssue = techIssues.find(i =>
          i.rule === 'missing-meta-description' || i.rule === 'meta-description-too-short'
        );
        if (metaIssue) {
          metaIssue.autoFix = {
            type: 'generated-meta-desc',
            text: generated,
            current: desc || null
          };
          metaIssue.detail += ` Auto-generated: "${generated}"`;
        }
      }
      await sleep(500);
    }

    // E: PageSpeed Insights for priority pages
    const psiIssues = [];
    if (PAGESPEED_PAGES.has(path.basename(rel))) {
      const psi = await checkPageSpeed(getCanonicalUrl(rel));
      if (psi) {
        if (psi.score < 50) {
          psiIssues.push({ severity: 'CRITICAL', rule: 'pagespeed-poor', detail: `Mobile performance score: ${psi.score}/100. LCP: ${psi.lcp}, CLS: ${psi.cls}. Needs urgent improvement.`, autoFix: null });
        } else if (psi.score < 70) {
          psiIssues.push({ severity: 'WARNING', rule: 'pagespeed-needs-work', detail: `Mobile performance score: ${psi.score}/100. LCP: ${psi.lcp}, CLS: ${psi.cls}. Room for improvement.`, autoFix: null });
        } else {
          psiIssues.push({ severity: 'INFO', rule: 'pagespeed-good', detail: `Mobile performance score: ${psi.score}/100. LCP: ${psi.lcp}, CLS: ${psi.cls}.`, autoFix: null });
        }
      }
      await sleep(1000);
    }

    const allIssues = [...techIssues, ...contentIssues, ...psiIssues];
    allIssues.forEach(i => { totals[i.severity] = (totals[i.severity] || 0) + 1; });

    const c = allIssues.filter(i => i.severity === 'CRITICAL').length;
    const w = allIssues.filter(i => i.severity === 'WARNING').length;
    const icon = c > 0 ? '🔴' : w > 0 ? '🟡' : '✅';
    console.log(`${icon}  ${c}C ${w}W`);

    results.push({ file: rel, url: getCanonicalUrl(rel), title, issues: allIssues });

    if (!skipContent) await sleep(800);
  }

  // ── Phase 2: Cross-page analysis ──────────────────────────────────────────
  checkBrokenLinks(results);
  detectDuplicates(results);

  // ── Phase 3: Competitor gap analysis ──────────────────────────────────────
  const competitorGaps = await analyzeCompetitorGaps(results);

  // ── Save output ───────────────────────────────────────────────────────────
  // Recount after post-processing
  let critTotal = 0, warnTotal = 0, infoTotal = 0;
  results.forEach(r => r.issues.forEach(i => {
    if (i.severity === 'CRITICAL') critTotal++;
    else if (i.severity === 'WARNING') warnTotal++;
    else infoTotal++;
  }));

  fs.writeFileSync(
    path.join(SITE_ROOT, 'seo-results.json'),
    JSON.stringify({ results, competitorGaps }, null, 2)
  );

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Total: ${files.length} pages | 🔴 ${critTotal} critical | 🟡 ${warnTotal} warnings | ℹ️ ${infoTotal} info`);
  console.log(`Results → seo-results.json`);

  if (process.env.GITHUB_OUTPUT) {
    const hasFixes = results.some(r => r.issues.some(i => i.autoFix));
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `critical=${critTotal}\nwarnings=${warnTotal}\ninfo=${infoTotal}\nhas_fixes=${hasFixes}\n`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
