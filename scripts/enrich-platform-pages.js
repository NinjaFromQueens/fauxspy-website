/**
 * Faux Spy — Platform Transparency Data Enrichment
 * Re-generates existing platform pages with real enforcement stats from the
 * Platform Transparency Data spreadsheet tab (currently unused in any pages).
 *
 * These stats (Facebook: 1.1B accounts removed, LinkedIn: 80.6M, etc.) are
 * the differentiating data that makes pages rank — injected as mandatory leading
 * facts alongside the existing key stat.
 *
 * Usage:
 *   node scripts/enrich-platform-pages.js              # enrich all platforms
 *   node scripts/enrich-platform-pages.js --dry-run    # preview only
 *   node scripts/enrich-platform-pages.js --slug facebook  # one page
 *
 * Required env: ANTHROPIC_API_KEY
 * Run fetch-sheet-data.js first if sheet-data.json is stale.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { default: Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const SITE_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(SITE_ROOT, 'pages');
const DATA_FILE = path.join(__dirname, 'data', 'sheet-data.json');
const SITE_BASE = 'https://www.fauxspy.com';
const CWS_URL = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SLUG_FILTER = (() => { const i = args.indexOf('--slug'); return i >= 0 ? args[i + 1] : null; })();

if (!process.env.ANTHROPIC_API_KEY) { console.error('❌ ANTHROPIC_API_KEY not set.'); process.exit(1); }
if (!fs.existsSync(DATA_FILE)) { console.error('❌ sheet-data.json not found. Run fetch-sheet-data.js first.'); process.exit(1); }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Parse Platform Transparency Data ────────────────────────────────────────

function buildPlatformStatsMap(sheetData) {
  const platformTab = sheetData.tabs['Platform Transparency Data'];
  if (!platformTab || !platformTab.rows.length) {
    console.warn('⚠️  Platform Transparency Data tab not found or empty.');
    return {};
  }

  const map = {}; // slug → array of stats

  for (const row of platformTab.rows) {
    const pageUse = String(row['FauxSpy Page Use'] || '').trim();
    const keyStat = String(row['Key Stat'] || '').trim();
    const source = String(row['Period / Source'] || '').trim();
    const context = String(row['Platform / Source'] || '').trim();

    if (!pageUse || !keyStat || pageUse === 'FauxSpy Page Use') continue;

    // Extract slug(s) from "FauxSpy Page Use" — may contain multiple like "/facebook /instagram"
    const slugMatches = pageUse.match(/\/[a-z][a-z0-9-]*/g) || [];
    for (const slug of slugMatches) {
      const clean = slug.replace(/^\//, '');
      if (!map[clean]) map[clean] = [];
      map[clean].push({ stat: keyStat, source, context });
    }
  }

  return map;
}

// ─── Also pull entity database keyStat for each slug ─────────────────────────

function buildEntityKeyStatMap(sheetData) {
  const entityTab = sheetData.tabs['📋 Entity Database'];
  if (!entityTab) return {};
  const map = {};
  for (const row of entityTab.rows) {
    const slug = String(row['Slug'] || '').replace(/^\//, '').trim();
    const stat = String(row['Key Differentiating Stat / Angle'] || '').trim();
    const name = String(row['Entity Name'] || '').trim();
    const cat = String(row['Category'] || '').trim();
    if (slug && stat) map[slug] = { stat, name, category: cat };
  }
  return map;
}

// ─── Cached system prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are re-generating SEO landing pages for Faux Spy, a Chrome extension that detects AI-generated images and deepfakes. Users hover or right-click any image in Chrome to get an instant AI vs. Real verdict.

PRODUCT FACTS:
- Free: 10 checks/day, no account needed, works on any website in Chrome
- Pro: Unlimited checks ($9.99/mo or $99/yr), deepfake detection, manipulation detection
- Chrome Web Store: ${CWS_URL}

WRITING RULES:
- Write like a person, direct, no hedging, no filler
- Short paragraphs (3–4 sentences max), vary rhythm
- Use second person ("you") throughout
- Each H2 must make a real point, not just label a category
- Use the exact statistics provided — do not invent or approximate
- Contradict a common assumption at least once
- Aim for 1,000–1,500 words of body content

BANNED PHRASES: "it's worth noting", "delve into", "navigate", "furthermore", "in conclusion", "in summary", "cutting-edge", "game-changing", "in today's digital age", "the importance of", "let's explore", "as we've seen"

HTML STRUCTURE — use EXACTLY this:
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[50-60 chars, keyword first]</title>
  <meta name="description" content="[150-160 char description]">
  <meta property="og:title" content="[OG title]">
  <meta property="og:description" content="[OG description]">
  <meta property="og:image" content="https://fauxspy.com/og-image.png">
  <meta property="og:url" content="[CANONICAL URL]">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="[CANONICAL URL]">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">
  [FAQPage schema + HowTo schema as separate JSON-LD blocks]
  </script>
  <script defer src="/_vercel/insights/script.js"></script>
  <script defer src="/_vercel/speed-insights/script.js"></script>
  <script>
    var ahrefs_analytics_script = document.createElement('script');
    ahrefs_analytics_script.async = true;
    ahrefs_analytics_script.src = 'https://analytics.ahrefs.com/analytics.js';
    ahrefs_analytics_script.setAttribute('data-key', 'LxH/OIwN7rRfH9EsLfyKGw');
    document.getElementsByTagName('head')[0].appendChild(ahrefs_analytics_script);
  </script>
</head>
<body>
  <nav class="nav">
    <div class="nav-container">
      <a href="/" class="nav-logo">
        <img src="/logo.png" alt="Faux Spy" width="32" height="32">
        <span class="nav-brand">Faux Spy</span>
      </a>
      <div class="nav-links">
        <a href="/#features">Features</a>
        <a href="/faq">FAQ</a>
        <a href="/blog">Blog</a>
        <a href="/pro">Pro</a>
        <a href="${CWS_URL}" class="btn btn-primary btn-small" target="_blank" rel="noopener">Add to Chrome</a>
      </div>
    </div>
  </nav>

  <div class="landing-page">
    <div class="container">
      <div class="landing-hero">
        <h1>[COMPELLING H1 — platform name + fake/AI detection angle]</h1>
        <p class="landing-subtitle">[MUST include the primary enforcement stat in the first sentence. E.g. "Facebook removes 1.1 billion fake accounts per quarter — and that's just what their systems catch."]</p>
        <a href="${CWS_URL}" class="btn btn-primary btn-large" target="_blank" rel="noopener">&#x1F575;&#xFE0F; Add to Chrome — Free</a>
        <p class="landing-note">10 checks/day free. No account required.</p>
      </div>

      [3-5 .landing-section divs — each with bold H2 and 3-4 short paragraphs]

      <div class="landing-faq">
        <h2>Common questions</h2>
        [5-6 <details class="faq-item"> elements]
      </div>

      <div class="landing-cta">
        <h2>[Benefit CTA]</h2>
        <p>[1-2 sentences]</p>
        <a href="${CWS_URL}" class="btn btn-primary btn-large" target="_blank" rel="noopener">&#x1F575;&#xFE0F; Add to Chrome &#x2014; Free</a>
      </div>
    </div>
  </div>

  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <div class="footer-logo">
            <img src="/logo.png" alt="Faux Spy" width="32" height="32">
            <span class="footer-name">Faux Spy</span>
          </div>
          <p class="footer-tagline">Spy on the fakes.</p>
        </div>
        <div class="footer-col">
          <h4>Product</h4>
          <a href="/#features">Features</a>
          <a href="/#pricing">Pricing</a>
          <a href="/faq">FAQ</a>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/contact">Contact</a>
          <a href="/blog">Blog</a>
        </div>
        <div class="footer-col">
          <h4>Use Cases</h4>
          <a href="/deepfake-detector">Deepfake Detector</a>
          <a href="/catfish-detector">Catfish Detector</a>
          <a href="/dating-apps">Dating Apps</a>
          <a href="/tinder">Tinder</a>
          <a href="/bumble">Bumble</a>
          <a href="/facebook">Facebook</a>
          <a href="/instagram">Instagram</a>
          <a href="/linkedin">LinkedIn</a>
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; 2026 Faux Spy. Spy on the fakes.</p>
      </div>
    </div>
  </footer>
</body>
</html>

Return ONLY the complete HTML. No markdown fences. Start with <!DOCTYPE html>.`;

// ─── Generate enriched page ───────────────────────────────────────────────────

async function generateEnrichedPage(slug, platformStats, entityData) {
  const canonicalUrl = `${SITE_BASE}/${slug}`;
  const platformName = entityData?.name || slug.replace(/-/g, ' ');

  // Format top stats (limit to most impactful 6 for the prompt)
  const topStats = platformStats.slice(0, 6).map(s =>
    `• ${s.stat} (${s.source}) — Context: ${s.context}`
  ).join('\n');

  const prompt = `Re-generate the landing page for FauxSpy's "${platformName}" page.
Page URL: ${canonicalUrl}
Platform: ${platformName}
Primary keyword: "${entityData?.name || platformName} fake profile detector" or "AI photos on ${platformName}"

PLATFORM TRANSPARENCY DATA (real enforcement stats — use these verbatim in the page):
${topStats}

ENTITY DIFFERENTIATING STAT: "${entityData?.stat || ''}"

CONTENT REQUIREMENTS:
- H1: Lead with ${platformName} + fake/AI detection angle. Under 65 chars.
- Landing subtitle MUST open with the biggest enforcement stat (e.g., "${platformStats[0]?.stat}"). This is the hook.
- Section 1: Scale of the fake account problem on ${platformName} — use the enforcement numbers to show why manual detection fails
- Section 2: How AI-generated photos specifically made catfishing on ${platformName} worse — what changed in 2024-25
- Section 3: What ${platformName}'s own systems miss (the detection gap Faux Spy fills)
- Section 4: Step-by-step how to use Faux Spy on ${platformName} — <ol class="landing-steps">
- FAQ: 5-6 platform-specific questions using real stats in answers
- Schema: FAQPage + HowTo
- Internal links: /catfish-detector, /deepfake-detector, and 2-3 related platform pages
- Source: cite enforcement data by name (Meta transparency report, LinkedIn transparency report, etc.)

MANDATORY: The opening stat (${platformStats[0]?.stat}) MUST appear in both the hero subtitle AND be bolded in the first landing-section. This is what differentiates this page from all other AI detector pages.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });

  let html = response.content[0].text.trim();
  if (html.startsWith('```')) html = html.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();
  return html;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🕵️  Faux Spy — Platform Transparency Enrichment');
  if (DRY_RUN) console.log('   [DRY RUN]');

  const sheetData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const platformStatsMap = buildPlatformStatsMap(sheetData);
  const entityKeyStatMap = buildEntityKeyStatMap(sheetData);

  console.log(`\n📊 Platform stats loaded for ${Object.keys(platformStatsMap).length} slugs:`);
  Object.entries(platformStatsMap).forEach(([slug, stats]) =>
    console.log(`   /${slug}: ${stats.length} data points`)
  );

  // Find pages in pages/ that match platform stats
  const targets = Object.entries(platformStatsMap)
    .filter(([slug]) => {
      if (SLUG_FILTER && slug !== SLUG_FILTER) return false;
      const filePath = path.join(PAGES_DIR, `${slug}.html`);
      return fs.existsSync(filePath);
    });

  console.log(`\n🎯 ${targets.length} existing pages to enrich with Platform Transparency data`);
  if (targets.length === 0) {
    console.log('   No matching pages found in pages/ directory.');
    return;
  }

  let updated = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const [slug, stats] = targets[i];
    const filePath = path.join(PAGES_DIR, `${slug}.html`);
    const entityData = entityKeyStatMap[slug] || null;
    const prefix = `[${i + 1}/${targets.length}]`;

    if (DRY_RUN) {
      console.log(`${prefix} DRY   /${slug} — ${stats.length} stats, top: "${stats[0]?.stat?.slice(0, 60)}"`);
      continue;
    }

    process.stdout.write(`${prefix} ENRICH /${slug}... `);
    try {
      const html = await generateEnrichedPage(slug, stats, entityData);
      fs.writeFileSync(filePath, html, 'utf8');
      console.log(`✅ (${(html.length / 1024).toFixed(0)}KB)`);
      updated++;
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ Done: ${updated} enriched, ${failed} failed`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
