/**
 * Faux Spy — Programmatic Landing Page Generator
 * Reads sheet-data.json (from fetch-sheet-data.js) and generates HTML landing pages.
 *
 * Usage:
 *   node scripts/generate-landing-pages.js                   # generate all
 *   node scripts/generate-landing-pages.js --dry-run         # preview only, no writes
 *   node scripts/generate-landing-pages.js --type state      # one page type
 *   node scripts/generate-landing-pages.js --limit 5         # cap at N pages
 *   node scripts/generate-landing-pages.js --force           # re-generate existing pages
 *
 * Required env: ANTHROPIC_API_KEY
 * Run fetch-sheet-data.js first to populate scripts/data/sheet-data.json
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
const TODAY = new Date().toISOString().split('T')[0];

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const TYPE_FILTER = (() => { const i = args.indexOf('--type'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY not set.');
  process.exit(1);
}
if (!fs.existsSync(DATA_FILE)) {
  console.error('❌ scripts/data/sheet-data.json not found. Run fetch-sheet-data.js first.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function slugFromUrl(url) {
  return String(url).replace(/^\//, '').trim();
}

function isDataRow(row, expectedHeaders) {
  // Skip rows that are section headers (have only 1 column populated, or look like tier labels)
  const values = Object.values(row).filter(v => String(v).trim() !== '');
  if (values.length <= 1) return false;
  const firstVal = String(Object.values(row)[0] || '').trim();
  if (/^TIER\s+\d/i.test(firstVal) || /^URL Slug$/i.test(firstVal)) return false;
  return true;
}

// ─── FBI IC3 data extraction ──────────────────────────────────────────────────

function buildFbiLookup(fbiTab) {
  if (!fbiTab) return { national: {}, states: {} };
  const national = {};
  const states = {};

  for (const row of fbiTab.rows) {
    const metric = String(row['Metric'] || '').trim();
    const figure = String(row['2024 Figure'] || '').trim();
    const trend = String(row['vs. 2023'] || '').trim();
    const pageUse = String(row['Usage for FauxSpy Pages'] || '').trim();

    if (!metric) continue;

    // State rows: Metric = state name, Figure = dollar losses, trend = rank
    if (trend.match(/^#\d/) || pageUse.includes('/romance-scam') || pageUse.includes('/catfish-detector-')) {
      states[metric.toLowerCase()] = { state: metric, losses: figure, rank: trend, pages: pageUse };
    } else if (metric !== 'State' && !metric.startsWith('SECTION')) {
      // National/aggregate metric rows
      national[metric] = { figure, trend, pageUse };
    }
  }

  return { national, states };
}

function getNationalStat(national, ...keys) {
  for (const key of keys) {
    const entry = national[key];
    if (entry && entry.figure) return entry.figure;
  }
  return '';
}

// ─── Data assembly for all tabs ───────────────────────────────────────────────

function buildSheetContext(sheetData) {
  const tabs = sheetData.tabs;

  // Get tabs by their actual names
  const fbiTab = tabs['FBI IC3 Data'];
  const ftcTab = tabs['FTC Sentinel Data'];
  const pewTab = tabs['Pew & Catfishing Stats'];
  const platformTab = tabs['Platform Transparency Data'];
  const keywordTab = tabs['🔑 Keyword Strategy'];
  const entityTab = tabs['📋 Entity Database'];
  const pageBuilderTab = tabs['📋 Page Builder Matrix'];
  const aiResearchTab = tabs['AI Detection Research'];

  const { national: fbiNational, states: fbiStates } = buildFbiLookup(fbiTab);

  // Build FTC lookup
  const ftcNational = {};
  if (ftcTab) {
    for (const row of ftcTab.rows) {
      const m = String(row['Metric'] || '').trim();
      const f = String(row['2024 Figure'] || '').trim();
      if (m && f && !m.startsWith('SECTION') && m !== 'Metric' && m !== 'State' && m !== 'Year') {
        ftcNational[m] = f;
      }
    }
  }

  // Build Pew stats lookup
  const pewStats = {};
  if (pewTab) {
    for (const row of pewTab.rows) {
      const stat = String(row['Statistic'] || '').trim();
      const figure = String(row['Figure'] || '').trim();
      if (stat && figure && !stat.startsWith('SECTION') && stat !== 'Statistic') {
        pewStats[stat] = { figure, source: row['Source / Year'] || '', pageUse: row['FauxSpy Page Use'] || '' };
      }
    }
  }

  // Aggregate key national stats
  const nationalStats = {
    totalLosses: getNationalStat(fbiNational,
      'Total financial losses (romance/confidence)',
      'Total financial losses'),
    totalComplaints: getNationalStat(fbiNational,
      'Total romance/confidence reports (IC3)',
      'Total romance/confidence reports'),
    avgLoss: getNationalStat(fbiNational,
      'Avg loss per romance scam victim',
      'Average loss per victim'),
    aiUsed: getNationalStat(fbiNational, 'AI used in romance scams'),
    estimatedTrue: getNationalStat(fbiNational, 'Estimated true total (unreported)'),
    ftcRomanceLosses: ftcNational['Romance scam losses (FTC, 2023)'] || '',
    ftcMedianLoss: ftcNational['Median loss per romance scam victim'] || '',
    ftcRomanceReports: ftcNational['Romance scam reports (FTC 2023)'] || '',
    pewCatfishSaw: pewStats['Online dating users who encountered a scammer / possible scammer'] || pewStats['% ever catfished online'] || {},
    year: '2024',
  };

  return {
    fbiNational,
    fbiStates,
    ftcNational,
    pewStats,
    nationalStats,
    keywordRows: keywordTab ? keywordTab.rows.filter(r => r['Slug / URL'] && r['Primary Keyword'] && !r['Primary Keyword'].includes('TIER') && r['Slug / URL'] !== 'Slug / URL') : [],
    pageBuilderRows: pageBuilderTab ? pageBuilderTab.rows.filter(r => isDataRow(r, pageBuilderTab.headers) && r['URL Slug']) : [],
    entityRows: entityTab ? entityTab.rows.filter(r => r['Entity Name'] && r['Entity Name'] !== 'Entity Name') : [],
    aiResearchRows: aiResearchTab ? aiResearchTab.rows.filter(r => r['AI Generator'] && r['AI Generator'] !== 'AI Generator') : [],
  };
}

// ─── Entity Database helpers ──────────────────────────────────────────────────

function categoryToPageType(category) {
  const c = String(category).toLowerCase();
  if (c.includes('ai generator')) return 'generator';
  if (c.includes('dating app')) return 'keyword';
  if (c.includes('social platform')) return 'keyword';
  if (c.includes('scam type')) return 'stats';
  if (c.includes('us state') || c.includes('us city') || c.includes('country')) return 'state';
  return 'keyword';
}

function entityKeyword(name, category) {
  const c = String(category).toLowerCase();
  const n = String(name).trim();
  if (c.includes('ai generator')) return `${n} image detector`;
  if (c.includes('dating app')) return `${n} fake profile detector`;
  if (c.includes('social platform')) return `fake ${n} profiles AI detector`;
  if (c.includes('us state') || c.includes('us city') || c.includes('country')) return `romance scam ${n}`;
  return n;
}

// ─── Page plan assembly ───────────────────────────────────────────────────────

function buildPagePlan(ctx) {
  const seen = new Set();
  const pages = [];

  // Priority 0: Entity Database — every row is one page (the Zapier/Wise model)
  // "Key Differentiating Stat / Angle" = the unique data that prevents near-duplicate deindexing
  for (const row of ctx.entityRows) {
    const slug = slugFromUrl(row['Slug'] || '');
    const entityName = String(row['Entity Name'] || '').trim();
    const category = String(row['Category'] || '').trim();
    if (!slug || !entityName || category === 'Category' || !category) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const type = categoryToPageType(category);
    pages.push({
      slug,
      keyword: entityKeyword(entityName, category),
      type,
      keyStat: String(row['Key Differentiating Stat / Angle'] || '').trim(),
      volume: String(row['Est. Search Vol'] || '').trim(),
      priority: String(row['Priority'] || 'P3').trim(),
      category,
      source: 'entity-database',
    });
  }

  // Priority 1: Page Builder Matrix — explicit page targets
  for (const row of ctx.pageBuilderRows) {
    const slug = slugFromUrl(row['URL Slug'] || '');
    const keyword = String(row['Primary Keyword'] || '').trim();
    if (!slug || !keyword) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const keyStat = String(row['Key Stat to Lead With'] || '').trim();
    const dataSource = String(row['Data Source Tab'] || '').trim();
    const notes = String(row['Notes'] || '').trim();

    // Determine page type from slug pattern
    let type = 'keyword';
    if (slug.startsWith('romance-scam-') && !slug.startsWith('romance-scam-stat')) type = 'state';
    else if (slug.includes('-detector') && !slug.includes('catfish') && !slug.includes('deepfake')) type = 'generator';
    else if (slug.includes('statistics') || slug.includes('stats') || slug.includes('data')) type = 'stats';
    else if (slug.includes('vs-') || slug.includes('-vs-')) type = 'comparison';

    pages.push({ slug, keyword, type, keyStat, dataSource, notes, source: 'page-builder' });
  }

  // Priority 2: Keyword Strategy — unique slugs not in Page Builder Matrix
  const slugsSeen = new Set(pages.map(p => p.slug));
  const kwBySlug = {};
  for (const row of ctx.keywordRows) {
    const slug = slugFromUrl(row['Slug / URL'] || '');
    if (!slug || slug === '/' || slug === '') continue;
    if (!kwBySlug[slug]) kwBySlug[slug] = [];
    kwBySlug[slug].push(row);
  }

  for (const [slug, rows] of Object.entries(kwBySlug)) {
    if (slugsSeen.has(slug)) continue;
    slugsSeen.add(slug);
    const row = rows[0]; // primary keyword for this slug
    const keyword = row['Primary Keyword'];
    const volume = row['Est. Monthly Vol'];
    const intent = row['Intent'];
    const notes = row['Notes / Strategy'];

    let type = 'keyword';
    if (slug.startsWith('romance-scam-') || slug.startsWith('catfish-detector-')) type = 'state';
    else if (slug.includes('statistics') || slug.includes('stats') || slug.includes('blog/romance-scam')) type = 'stats';
    else if (slug.includes('vs-') || slug.includes('best-') || slug.includes('alternative')) type = 'comparison';
    else if (slug.includes('-detector') && !['catfish-detector','deepfake-detector','ai-art-detector','ai-video-detector'].includes(slug)) type = 'generator';
    else if (slug.startsWith('blog/')) type = 'blog';

    pages.push({ slug, keyword, type, volume, intent, notes, source: 'keyword-strategy' });
  }

  return pages;
}

// ─── System prompt (cached across all calls) ─────────────────────────────────

const SYSTEM_PROMPT = `You are generating SEO landing pages for Faux Spy, a Chrome extension that detects AI-generated images and deepfakes. Users hover or right-click any image in Chrome to get an instant AI vs. Real verdict with a confidence score.

PRODUCT FACTS:
- Free: 10 checks/day, no account needed, works on any website in Chrome
- Pro: Unlimited checks ($9.99/mo or $99/yr), adds deepfake detection and manipulation detection
- Chrome Web Store: ${CWS_URL}
- Works on: tinder.com, bumble.com, hinge.co, instagram.com, facebook.com, linkedin.com, pinterest.com, x.com, and any other website
- Detection categories: No AI Detected / AI Photo / AI Art / Digital Art / Possible Manipulation / Inconclusive

WRITING RULES — all apply without exception:
- Write like a person who built this tool after watching people get burned. Direct, no hedging, no filler.
- Short paragraphs (3–4 sentences max). Vary rhythm — mix long and short sentences.
- Use second person ("you") throughout.
- Each H2 must make a real point, not just label a category. "How to spot it" is weak. "The tell is in the lighting, not the face" is strong.
- Use the exact statistics provided in the data context. Do not invent or approximate numbers.
- Contradict a common assumption at least once.
- No fluff. If a sentence doesn't add information, cut it.
- Aim for 1,000–1,500 words of body content.

BANNED PHRASES — never use: "it's worth noting", "delve into", "navigate", "furthermore", "in conclusion", "in summary", "cutting-edge", "game-changing", "groundbreaking", "in today's digital age", "the importance of", "This article will", "we will cover", "as we've seen", "let's explore", "let's dive in", "it is worth", "additionally,", "moreover,"

HTML STRUCTURE — use EXACTLY this structure with these CSS classes:

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[50-60 chars, keyword first]</title>
  <meta name="description" content="[150-160 char description with primary keyword]">
  <meta property="og:title" content="[OG title]">
  <meta property="og:description" content="[OG description]">
  <meta property="og:image" content="https://fauxspy.com/og-image-v2.png">
  <meta property="og:url" content="[CANONICAL URL]">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="[CANONICAL URL]">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">
  [JSON-LD SCHEMA — FAQPage required. Add HowTo for how-to/tool pages. Add Article+Dataset for statistics pages. Add Review for comparison pages.]
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
        <h1>[COMPELLING H1 — primary keyword near front, under 70 chars]</h1>
        <p class="landing-subtitle">[2-3 sentence hook — lead with the key stat, end with how FauxSpy solves it]</p>
        <a href="${CWS_URL}" class="btn btn-primary btn-large" target="_blank" rel="noopener">&#x1F575;&#xFE0F; Add to Chrome — Free</a>
        <p class="landing-note">10 checks/day free. No account required.</p>
      </div>

      [3-5 .landing-section divs with H2 + paragraphs. For stats pages add tables with class="data-table". For how-to pages add <ol class="landing-steps">. For generator pages include an "accuracy" section.]

      <div class="landing-faq">
        <h2>Common questions</h2>
        [4-6 <details class="faq-item"> — each with <summary> question and <p> answer]
      </div>

      <div class="landing-cta">
        <h2>[Benefit-focused CTA headline]</h2>
        <p>[1-2 sentence supporting copy]</p>
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
          <a href="/hinge">Hinge</a>
          <a href="/facebook">Facebook</a>
          <a href="/instagram">Instagram</a>
          <a href="/linkedin">LinkedIn</a>
          <a href="/ai-art-detector">AI Art</a>
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; 2026 Faux Spy. Spy on the fakes.</p>
      </div>
    </div>
  </footer>
</body>
</html>

Return ONLY the complete HTML. No explanation before or after. No markdown code fences — just raw HTML starting with <!DOCTYPE html>.`;

// ─── Per-page prompt builders ─────────────────────────────────────────────────

function buildStatePagePrompt(page, ctx) {
  const stateSlug = page.slug.replace(/^romance-scam-/, '').replace(/^catfish-detector-/, '');
  const stateName = stateSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const canonicalUrl = `${SITE_BASE}/${page.slug}`;

  const stateData = ctx.fbiStates[stateName.toLowerCase()] || ctx.fbiStates[stateSlug] || null;
  const ns = ctx.nationalStats;

  const dataContext = {
    state: stateName,
    canonical_url: canonicalUrl,
    primary_keyword: page.keyword,
    key_stat: page.keyStat || (stateData ? `${stateData.losses} lost to romance scams in ${stateName}` : ''),
    state_losses: stateData?.losses || 'data not individually reported',
    state_rank: stateData?.rank || '',
    state_extra: stateData?.pages || '',
    national_total_losses: ns.totalLosses,
    national_total_complaints: ns.totalComplaints,
    national_avg_loss_per_victim: ns.avgLoss,
    ftc_romance_losses: ns.ftcRomanceLosses,
    ftc_romance_reports: ns.ftcRomanceReports,
    ai_in_scams: ns.aiUsed,
    data_year: ns.year,
    notes: page.notes || '',
  };

  return `Generate a state-specific landing page for ${stateName}.
Page URL: ${canonicalUrl}
Primary keyword: "${page.keyword}"
Page type: STATE — romance scam statistics and AI catfishing for ${stateName}

DATA CONTEXT — use these exact figures, do not modify or estimate:
${JSON.stringify(dataContext, null, 2)}

CONTENT REQUIREMENTS:
- H1: Lead with the dollar amount or complaint number (e.g., "${stateName} Romance Scam Victims Lost ${stateData?.losses || 'Millions'}" or "Spotting Fake Profiles in ${stateName}")
- Hero subtitle: Combine ${stateName}'s specific numbers with the AI-generated photo angle — why FauxSpy is the solution
- Section 1: ${stateName}'s specific numbers vs. the national picture. Use exact figures from the data context.
- Section 2: How AI-generated photos specifically power romance scams — the technical problem FauxSpy solves
- Section 3: How to check any profile photo in Chrome using FauxSpy — step-by-step with <ol class="landing-steps">
- Section 4: What to do if targeted in ${stateName} — report to FTC, IC3, local resources
- FAQ: 4-5 ${stateName}-specific questions ("How many romance scam complaints were filed in ${stateName}?", "What's the average loss for ${stateName} victims?")
- Schema: FAQPage + HowTo
- Internal links: /catfish-detector, /dating-apps, /deepfake-detector, /romance-scam-statistics-2025 (if it exists)
- Source attribution: FBI IC3 Internet Crime Report 2024

MANDATORY UNIQUENESS REQUIREMENT: This page's differentiating stat is: "${page.keyStat || `${stateName} romance scam losses`}"
This exact stat or its key number MUST appear: (1) in the landing-subtitle hero paragraph, AND (2) bolded in the first landing-section. No other FauxSpy page uses this specific stat — it is what prevents Google treating this as a near-duplicate.`;
}

function buildGeneratorPagePrompt(page, ctx) {
  const canonicalUrl = `${SITE_BASE}/${page.slug}`;
  const generatorName = page.keyword.replace(/detector|image detector|detect\s+/i, '').trim();

  // Find AI research data for this generator
  const aiResearch = ctx.aiResearchRows.find(r =>
    String(r['AI Generator'] || '').toLowerCase().includes(generatorName.toLowerCase())
  );

  const ns = ctx.nationalStats;

  const dataContext = {
    generator_name: generatorName,
    canonical_url: canonicalUrl,
    primary_keyword: page.keyword,
    key_stat: page.keyStat || '',
    detection_accuracy: aiResearch?.['Detection Accuracy (Best Tools)'] || '',
    difficulty_level: aiResearch?.['Difficulty Level'] || '',
    fauxspy_page_target: aiResearch?.['FauxSpy Page'] || '',
    national_avg_loss: ns.avgLoss,
    notes: page.notes || '',
  };

  return `Generate a landing page targeting: "${page.keyword}"
Page URL: ${canonicalUrl}
Page type: AI GENERATOR DETECTOR — detects images made by ${generatorName}

DATA CONTEXT:
${JSON.stringify(dataContext, null, 2)}

CONTENT REQUIREMENTS:
- H1: "[Generator Name] Image Detector — Real or AI?" or "How to Detect [Generator Name] Images"
- Hero subtitle: What makes ${generatorName} images distinctive, why Faux Spy catches them
- Section 1: How ${generatorName} creates images — the specific visual tells (hair, lighting, backgrounds, skin texture)
- Section 2: Why ${generatorName} images are being used in fake profiles and scams — the real-world context
- Section 3: How Faux Spy detects ${generatorName} — step-by-step with <ol class="landing-steps">
- Section 4: Accuracy and limitations — be honest about what Faux Spy catches vs. what might slip through
- FAQ: 4-5 questions — "Can Faux Spy detect ${generatorName} images?", "What makes ${generatorName} images hard to spot?", etc.
- Schema: FAQPage + HowTo
- Internal links: /deepfake-detector, /catfish-detector, and 2-3 related generator pages

MANDATORY UNIQUENESS REQUIREMENT: This page's differentiating stat is: "${page.keyStat}"
This exact stat or its key number MUST appear: (1) in the landing-subtitle hero paragraph, AND (2) bolded in the first landing-section. No other FauxSpy page uses this specific stat — it is what prevents Google treating this as a near-duplicate.`;
}

function buildStatsPagePrompt(page, ctx) {
  const canonicalUrl = `${SITE_BASE}/${page.slug}`;
  const ns = ctx.nationalStats;

  const dataContext = {
    canonical_url: canonicalUrl,
    primary_keyword: page.keyword,
    key_stat: page.keyStat || ns.totalLosses,
    national_total_losses_fbi: ns.totalLosses,
    national_total_complaints_fbi: ns.totalComplaints,
    national_avg_loss_fbi: ns.avgLoss,
    ai_used_in_scams: ns.aiUsed,
    ftc_romance_losses: ns.ftcRomanceLosses,
    ftc_romance_reports: ns.ftcRomanceReports,
    ftc_median_loss: ns.ftcMedianLoss,
    top_states: Object.values(ctx.fbiStates).slice(0, 8).map(s => ({
      state: s.state, losses: s.losses, rank: s.rank
    })),
    data_year: ns.year,
    source_fbi: 'FBI Internet Crime Complaint Center (IC3) 2024 Annual Report',
    source_ftc: 'FTC Consumer Sentinel Data Book 2024',
    notes: page.notes || '',
  };

  return `Generate a statistics landing page targeting: "${page.keyword}"
Page URL: ${canonicalUrl}
Page type: STATISTICS — comprehensive data hub for romance scam and AI fraud statistics

DATA CONTEXT — cite these exact figures with their sources:
${JSON.stringify(dataContext, null, 2)}

CONTENT REQUIREMENTS:
- H1: Lead with the biggest number (e.g., "$${ns.totalLosses} Lost to Romance Scams in 2024" or "Romance Scam Statistics 2024")
- Hero subtitle: Combine the headline loss figure with the AI angle
- Section 1: National headline stats — total losses, complaints, average per victim from FBI IC3. Use a table (class="data-table") if showing multiple metrics.
- Section 2: State-by-state breakdown — top states by losses, use a table with state, losses, and rank
- Section 3: Who gets targeted — demographics context (age groups, platforms used)
- Section 4: The AI escalation — how AI-generated images are increasing fraud effectiveness. Reference the AI stat if available.
- Section 5: How to protect yourself — FauxSpy CTA integrated naturally
- FAQ: 5+ questions — "How much is lost to romance scams per year?", "Which state loses the most to romance scams?", "Are romance scam statistics getting worse?"
- Schema: Article (news article type) + Dataset schema (cite FBI IC3 as source)
- Internal links: /catfish-detector, /deepfake-detector, 3-4 state pages (/romance-scam-california, /romance-scam-texas, /romance-scam-florida)
- Source attribution: Cite FBI IC3 and FTC by name

MANDATORY UNIQUENESS REQUIREMENT: This page's differentiating stat is: "${page.keyStat}"
This exact stat or its key number MUST appear: (1) in the landing-subtitle hero paragraph, AND (2) bolded in the first landing-section. No other FauxSpy page uses this specific stat — it is what prevents Google treating this as a near-duplicate.`;
}

function buildComparisonPagePrompt(page, ctx) {
  const canonicalUrl = `${SITE_BASE}/${page.slug}`;
  const competitor = page.slug.replace(/^faux-spy-vs-|^vs-/, '').replace(/-/g, ' ');
  const ns = ctx.nationalStats;

  const dataContext = {
    canonical_url: canonicalUrl,
    primary_keyword: page.keyword,
    competitor_name: competitor,
    national_avg_loss: ns.avgLoss,
    notes: page.notes || '',
  };

  return `Generate a comparison landing page targeting: "${page.keyword}"
Page URL: ${canonicalUrl}
Page type: COMPARISON — FauxSpy vs. ${competitor}

DATA CONTEXT:
${JSON.stringify(dataContext, null, 2)}

CONTENT REQUIREMENTS:
- H1: "FauxSpy vs. ${competitor}: Which Actually Catches AI Images?" (or similar direct framing)
- Do not trash the competitor. Be honest about what each does. FauxSpy wins on browser extension + any-site detection.
- Feature comparison table (class="data-table"): Price, How it works, Where it works, Detection types, Speed, Free tier
- FauxSpy strengths: works on any website in Chrome without copy-pasting, hover detection, real-time verdict, free tier
- Section: "Who should use FauxSpy" vs "Who might prefer ${competitor}" — be fair
- FAQ: 4-5 questions — "Is FauxSpy better than ${competitor}?", "Can I use both?", "What does FauxSpy detect that ${competitor} doesn't?", "Is FauxSpy free?"
- Schema: Review + FAQPage
- Internal links: /pro, /deepfake-detector, /catfish-detector
- Tone: Confident but fair. The reader is evaluating tools, not looking to be sold.

MANDATORY UNIQUENESS REQUIREMENT: This page's differentiating stat is: "${page.keyStat}"
This exact stat or its key number MUST appear: (1) in the landing-subtitle hero paragraph, AND (2) bolded in the first landing-section. No other FauxSpy page uses this specific stat — it is what prevents Google treating this as a near-duplicate.`;
}

function buildKeywordPagePrompt(page, ctx) {
  const canonicalUrl = `${SITE_BASE}/${page.slug}`;
  const ns = ctx.nationalStats;

  // Find relevant Pew or platform stats if available
  const pewEntry = Object.entries(ctx.pewStats).find(([k]) =>
    k.toLowerCase().includes('dating') || k.toLowerCase().includes('catfish') || k.toLowerCase().includes('scam')
  );

  const dataContext = {
    canonical_url: canonicalUrl,
    primary_keyword: page.keyword,
    key_stat: page.keyStat || '',
    search_intent: page.intent || '',
    monthly_volume: page.volume || '',
    notes: page.notes || '',
    national_losses: ns.totalLosses,
    national_avg_loss: ns.avgLoss,
    relevant_stat: pewEntry ? `${pewEntry[0]}: ${pewEntry[1].figure} (${pewEntry[1].source})` : '',
  };

  return `Generate a landing page targeting: "${page.keyword}"
Page URL: ${canonicalUrl}
Page type: KEYWORD/TOPIC — matches search intent for AI image detection

DATA CONTEXT:
${JSON.stringify(dataContext, null, 2)}

CONTENT REQUIREMENTS:
- H1: Contains the primary keyword or a close natural variant. Under 65 characters. No keyword stuffing.
- Hero subtitle: Address exactly what someone searching "${page.keyword}" needs. Be specific to the use case.
- Write 3-4 sections that directly answer what the user is looking for when they type "${page.keyword}"
- Include at least one real statistic from the data context
- How-to section: specific steps to use FauxSpy for this exact use case — use <ol class="landing-steps">
- FAQ: 4-5 questions matching "people also ask" patterns for this keyword
- Schema: FAQPage + HowTo
- Internal links: 2-3 related pages (catfish-detector, deepfake-detector, relevant platform pages)
- Tone: Direct. Address the specific problem. No generic openers.

MANDATORY UNIQUENESS REQUIREMENT: This page's differentiating stat is: "${page.keyStat}"
This exact stat or its key number MUST appear: (1) in the landing-subtitle hero paragraph, AND (2) bolded in the first landing-section. No other FauxSpy page uses this specific stat — it is what prevents Google treating this as a near-duplicate.`;
}

// ─── Prompt router ────────────────────────────────────────────────────────────

function buildPrompt(page, ctx) {
  switch (page.type) {
    case 'state':      return buildStatePagePrompt(page, ctx);
    case 'generator':  return buildGeneratorPagePrompt(page, ctx);
    case 'stats':      return buildStatsPagePrompt(page, ctx);
    case 'comparison': return buildComparisonPagePrompt(page, ctx);
    default:           return buildKeywordPagePrompt(page, ctx);
  }
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function generatePage(promptText) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: promptText }],
  }, {
    headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });

  let html = response.content[0].text.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();
  }
  return html;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🕵️  Faux Spy — Landing Page Generator');
  if (DRY_RUN) console.log('   [DRY RUN — no files will be written]');
  if (TYPE_FILTER) console.log(`   [TYPE FILTER: ${TYPE_FILTER}]`);
  if (LIMIT < Infinity) console.log(`   [LIMIT: ${LIMIT}]`);

  const sheetData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const ctx = buildSheetContext(sheetData);

  console.log('\n📊 Data loaded:');
  console.log(`   FBI IC3: ${Object.keys(ctx.fbiNational).length} national metrics, ${Object.keys(ctx.fbiStates).length} states`);
  console.log(`   FTC: ${Object.keys(ctx.ftcNational).length} metrics`);
  console.log(`   Pew stats: ${Object.keys(ctx.pewStats).length} stats`);
  console.log(`   Keywords: ${ctx.keywordRows.length} rows`);
  console.log(`   Page Builder: ${ctx.pageBuilderRows.length} rows`);
  console.log(`   Key national stats: $${ctx.nationalStats.totalLosses || '?'} in losses, ${ctx.nationalStats.totalComplaints || '?'} complaints`);

  // Build the full page plan
  const allPages = buildPagePlan(ctx);
  console.log(`\n🗂  Page plan: ${allPages.length} total pages`);
  const byType = {};
  for (const p of allPages) byType[p.type] = (byType[p.type] || 0) + 1;
  for (const [t, n] of Object.entries(byType)) console.log(`   ${t}: ${n}`);

  // Filter by type if requested
  let toProcess = TYPE_FILTER ? allPages.filter(p => p.type === TYPE_FILTER) : allPages;
  toProcess = toProcess.slice(0, LIMIT);

  if (toProcess.length === 0) {
    console.error(`\n❌ No pages match the requested filters.`);
    process.exit(1);
  }

  console.log(`\n🚀 Processing ${toProcess.length} page(s)...`);

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const page = toProcess[i];
    if (!page.slug) { skipped++; continue; }

    // Write to pages/ for landing pages; blog/ stays in blog/
    const outputBase = page.slug.startsWith('blog/') ? SITE_ROOT : PAGES_DIR;
    const filePath = path.join(outputBase, `${page.slug}.html`);
    // Also check root for pages that may have been written there by older batches
    const rootPath = path.join(SITE_ROOT, `${page.slug}.html`);
    const exists = fs.existsSync(filePath) || (!page.slug.startsWith("blog/") && fs.existsSync(rootPath));
    const prefix = `[${i + 1}/${toProcess.length}]`;

    if (exists && !FORCE) {
      console.log(`${prefix} SKIP  /${page.slug} (exists — use --force to regenerate)`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`${prefix} DRY   /${page.slug}  [${page.type}]  "${page.keyword}"`);
      if (page.keyStat) console.log(`        stat: ${page.keyStat}`);
      created++;
      continue;
    }

    process.stdout.write(`${prefix} GEN   /${page.slug} [${page.type}]... `);
    try {
      const prompt = buildPrompt(page, ctx);
      const html = await generatePage(prompt);

      // Ensure output directory exists
      if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });
      if (page.slug.startsWith('blog/')) {
        const blogDir = path.join(SITE_ROOT, 'blog');
        if (!fs.existsSync(blogDir)) fs.mkdirSync(blogDir, { recursive: true });
      }

      fs.writeFileSync(filePath, html, 'utf8');
      console.log(`✅ ${exists ? 'updated' : 'created'} (${(html.length / 1024).toFixed(0)}KB)`);
      exists ? updated++ : created++;

      // Throttle to avoid hitting rate limits
      if (i < toProcess.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ Done: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed`);

  if (!DRY_RUN && (created + updated) > 0) {
    console.log('\n📝 Updating sitemap...');
    try {
      require('./update-sitemap');
    } catch (err) {
      console.warn('   ⚠️  Could not auto-update sitemap:', err.message);
      console.warn('   Run: node scripts/update-sitemap.js');
    }
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
