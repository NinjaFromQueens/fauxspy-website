/**
 * Faux Spy Product Hunt Launch Blog Agent
 *
 * Researches the live PH listing (rank, upvotes, community comments), picks an
 * article angle based on what it finds, then writes a complete HTML blog post
 * grounded in the actual launch data — not static promotional copy.
 *
 * Usage: PH_URL="https://..." ANTHROPIC_API_KEY="..." node scripts/ph-launch-blog.js
 * Required env: ANTHROPIC_API_KEY
 * Optional env: PH_URL (if omitted, discovered via SERPAPI_KEY)
 *               SERPAPI_KEY (required if PH_URL not set)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { default: Anthropic } = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');

const SITE_ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(SITE_ROOT, 'blog');
const BLOG_INDEX = path.join(BLOG_DIR, 'index.html');
const SITEMAP_FILE = path.join(SITE_ROOT, 'sitemap.xml');
const INDEXNOW_FILE = path.join(SITE_ROOT, '.github', 'workflows', 'indexnow.yml');
const SITE_BASE = 'https://www.fauxspy.com';

const SLUG = 'faux-spy-product-hunt-launch';
const CATEGORY = 'Product Launch';
const CANONICAL_URL = `${SITE_BASE}/blog/${SLUG}`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY env var is required.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Cached system prompts ─────────────────────────────────────────────────────

const ARTICLE_SYSTEM_PROMPT = `You are writing a launch blog post for Faux Spy, a Chrome extension that detects AI-generated images and videos in real time.

AUTHOR VOICE: First-person plural ("we"). You are the builder. You shipped this, you watched the launch, you read the comments. Direct, a little understated — you're not celebrating yourself, you're sharing what happened and what it means. You've seen the fake profile screenshots. You know why this tool exists. Let that come through without moralizing.

THIS IS A LAUNCH NARRATIVE, NOT AN SEO ARTICLE:
- Not a listicle, not a how-to guide, not a "comprehensive overview"
- A story: what we built, why, what happened on launch day, what the community told us
- The reader may have come from Product Hunt — do not assume they know what Faux Spy is. Explain it briefly but don't make the explanation the centerpiece.
- Shorter than a typical blog post: 900–1,400 words

CRITICAL WRITING RULES:
- Start with the launch moment or a specific data point — not a definition or a product pitch
- Short paragraphs. 3–4 sentences max. Mix long and short. Use a single short sentence (under 10 words) as its own paragraph at least twice.
- Use "we" throughout. This is a first-person account.
- Each H2 heading must make a real point, not just label a section.
- You MUST include the actual upvote count and/or rank from the launch data if provided — these are real numbers, not estimates.
- You MUST reference at least one specific theme from the community comments if they're provided.
- Tell readers what Faux Spy actually does in one clear sentence. Don't bury it or assume they know.
- End with something honest — not a sales pitch, not a call to action disguised as reflection.

BANNED PHRASES — never use any of these:
"it's worth noting", "it's important to note", "delve into", "navigate", "in the realm of", "furthermore", "in conclusion", "in summary", "as we've seen", "when it comes to", "let's explore", "let's dive in", "it goes without saying", "at the end of the day", "cutting-edge", "game-changing", "groundbreaking", "needless to say", "a comprehensive guide", "in today's digital age", "the importance of", "This article will", "we will cover", "in this post", "additionally,", "moreover,", "it is worth", "it should be noted", "in order to", "as mentioned", "as noted", "excited to announce", "thrilled to share", "we are proud"

Return ONLY the complete HTML. No explanation before or after. No markdown fences — just raw HTML starting with <!DOCTYPE html>.`;

const REVISION_SYSTEM_PROMPT = `You are a sharp human editor. Your only job is to find and fix AI-sounding text in blog articles.

Find sentences or phrases that sound generic, formulaic, hedging, or AI-written. Rewrite ONLY those — keep everything else exactly as-is, including all HTML tags, structure, and attributes.

Common AI tells to hunt for:
- Topic sentences that just label a category instead of making a real point
- Transitions like "furthermore", "additionally", "it's important to note", "it's worth noting"
- Sentences that hedge when they should just say the thing directly
- Closing sentences that summarise what was just said
- Introductory clauses that delay getting to the point ("When it comes to X...", "In the world of...")
- Launch-post clichés: "excited to announce", "thrilled to share", "humbled by the response", "overwhelmed by the support"
- Any phrase from this banned list: "delve into", "navigate", "in the realm of", "cutting-edge", "game-changing", "groundbreaking", "in today's digital age", "comprehensive"

Return the complete HTML with your edits applied. No explanation before or after — just the corrected HTML starting with <!DOCTYPE html>.`;

// ─── Utilities ────────────────────────────────────────────────────────────────

const BANNED_PHRASES = [
  "it's worth noting", "it's important to note", "delve into", "navigate",
  "in the realm of", "furthermore", "in conclusion", "in summary", "as we've seen",
  "when it comes to", "let's explore", "let's dive in", "it goes without saying",
  "at the end of the day", "cutting-edge", "game-changing", "groundbreaking",
  "needless to say", "a comprehensive guide", "in today's digital age",
  "the importance of", "this article will", "we will cover", "in this post",
  "additionally,", "moreover,", "it is worth", "it should be noted",
  "in order to", "as mentioned", "as noted", "excited to announce",
  "thrilled to share", "humbled by the response", "overwhelmed by the support",
];

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

function formatDisplayDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function scanForAIPhrases(html) {
  const text = stripTags(html).toLowerCase();
  return BANNED_PHRASES.filter(p => text.includes(p.toLowerCase()));
}

function readStyleExamples() {
  let files;
  try {
    files = fs.readdirSync(BLOG_DIR)
      .filter(f => f.endsWith('.html') && f !== 'index.html')
      .slice(0, 3);
  } catch {
    return [];
  }

  const examples = [];
  for (const file of files) {
    const html = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
    const sections = [...html.matchAll(/<div class="landing-section">([\s\S]*?)<\/div>/g)]
      .slice(0, 2)
      .map(m => stripTags(m[1]).slice(0, 500))
      .filter(s => s.length > 100);
    if (sections.length) examples.push({ file, sections });
  }
  return examples;
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  return m ? m[1].trim() : 'Faux Spy Product Hunt Launch';
}

function extractMetaDesc(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  return m ? m[1].trim() : '';
}

// ─── PH URL discovery ─────────────────────────────────────────────────────────

async function discoverPHUrl() {
  if (!process.env.SERPAPI_KEY) return null;

  console.log('Discovering PH listing URL via SerpAPI...');
  const params = new URLSearchParams({
    q: '"Faux Spy" site:producthunt.com/posts',
    api_key: process.env.SERPAPI_KEY,
    num: '5',
    hl: 'en',
    gl: 'us',
  });

  try {
    const resp = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`SerpAPI ${resp.status}`);
    const data = await resp.json();
    const hit = (data.organic_results || []).find(r => r.link?.includes('producthunt.com/posts/'));
    if (hit) {
      console.log(`  Found: ${hit.link}`);
      return hit.link;
    }
  } catch (err) {
    console.warn(`  SerpAPI discovery failed: ${err.message}`);
  }
  return null;
}

// ─── Fetch and parse PH page ──────────────────────────────────────────────────

async function fetchPHPageText(url) {
  console.log(`Fetching PH page: ${url}`);
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    const $ = cheerio.load(raw);
    // Remove noise
    $('script, style, nav, iframe, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 10000);
    console.log(`  Fetched ${text.length} chars of page text`);
    return text;
  } catch (err) {
    console.warn(`  Could not fetch PH page: ${err.message}`);
    return null;
  }
}

async function parsePHData(pageText) {
  if (!pageText) return null;

  console.log('Extracting launch data from PH page...');
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Extract Product Hunt launch data from this page text. Return a JSON object only — no explanation.

Fields:
- rank: string like "#1", "#2", "#3", or null if rank not found or outside top 10
- rankLabel: string like "Product of the Day" / "Product of the Week", or null
- upvotes: number or null
- commentCount: number or null
- tagline: string (the product's tagline/subtitle), or null
- topComments: array of up to 5 comment strings — skip anything under 20 words or purely generic ("Great product!", "Love this!")

PAGE TEXT:
${pageText}

Return JSON only.`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const data = match ? JSON.parse(match[0]) : null;
    if (data) {
      const rank = data.rank ? parseInt(data.rank.replace('#', ''), 10) : null;
      console.log(`  Rank: ${data.rank || 'not found'} | Upvotes: ${data.upvotes || 'unknown'} | Comments: ${data.commentCount || 'unknown'}`);
      if (data.topComments?.length) {
        console.log(`  ${data.topComments.length} community comments extracted`);
      }
      return { ...data, rankNum: rank };
    }
  } catch { /* fall through */ }
  console.warn('  Could not parse PH data — will use builder_story angle');
  return null;
}

// ─── Angle selection ──────────────────────────────────────────────────────────

function pickAngle(phData) {
  if (!phData) return 'builder_story';
  const { rankNum } = phData;
  if (rankNum && rankNum <= 3) return 'top_product';
  if (rankNum && rankNum <= 10) return 'strong_launch';
  return 'builder_story';
}

// ─── Build PH context for the generation prompt ───────────────────────────────

function buildPHContext(phData, angle) {
  const lines = ['PRODUCT HUNT LAUNCH DATA — you MUST use these real numbers and quotes in the article:\n'];

  if (phData) {
    if (phData.rank && phData.rankLabel) {
      lines.push(`Launch rank: ${phData.rank} ${phData.rankLabel}`);
    } else if (phData.rank) {
      lines.push(`Launch rank: ${phData.rank}`);
    }
    if (phData.upvotes) lines.push(`Upvotes received: ${phData.upvotes}`);
    if (phData.commentCount) lines.push(`Comments: ${phData.commentCount}`);
    if (phData.tagline) lines.push(`Product tagline on PH: "${phData.tagline}"`);

    if (phData.topComments?.length) {
      lines.push('\nWhat the community said (direct quotes from PH comments):');
      phData.topComments.forEach(c => lines.push(`  - "${c}"`));
      lines.push('\nIdentify 1-2 recurring themes in these comments and reference them in the article — they show what use cases actually resonated.');
    }
  } else {
    lines.push('(PH data unavailable — write from the builder perspective without citing specific numbers.)');
  }

  lines.push('');

  const angleMap = {
    top_product: `ARTICLE ANGLE (top_product): Open with the launch result. State the rank in the first 2-3 sentences. "We launched Faux Spy on Product Hunt. We hit ${phData?.rank || 'the top 3'}." Then explain what Faux Spy is in one sentence, and spend the rest of the article on the story: why we built it, what the PH community's response told us about who actually needs this. Do NOT make it a victory lap — be matter-of-fact.`,
    strong_launch: `ARTICLE ANGLE (strong_launch): Start with the launch day. Reference the rank and upvote count as concrete facts, but keep the focus on the product and the community response — what the ${phData?.upvotes || 'many'} upvotes and comments revealed about real use cases. Explain what Faux Spy does early. The rank is a data point, not the thesis.`,
    builder_story: `ARTICLE ANGLE (builder_story): No rank to lead with. Tell the story of why Faux Spy was built — start with the problem (fake profiles, AI-generated images spreading undetected) before mentioning the product. Use the community comments as evidence for real use cases. Be honest that the launch was a step, not a finish line.`,
  };

  lines.push(angleMap[angle]);
  return lines.join('\n');
}

// ─── Article generation (Claude Opus) ────────────────────────────────────────

async function generateArticle(displayDate, phData, angle) {
  const examples = readStyleExamples();
  const styleContext = examples.length > 0
    ? `STYLE EXAMPLES from existing Faux Spy articles — study the tone and directness:\n\n` +
      examples.map(e => `--- ${e.file} ---\n${e.sections.join('\n\n')}`).join('\n\n') + '\n\n'
    : '';

  const phContext = buildPHContext(phData, angle);

  const userPrompt = `${styleContext}${phContext}

Write a complete blog article for Faux Spy's Product Hunt launch. Date: ${displayDate}.

Output a complete HTML article file using EXACTLY this structure:

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Article Title] | Faux Spy</title>
  <meta name="description" content="[130-155 character meta description — specific and honest, not hype]">
  <meta property="og:title" content="[Article Title]">
  <meta property="og:description" content="[OG description]">
  <meta property="og:image" content="https://www.fauxspy.com/og-image-v2.png">
  <meta property="og:url" content="${CANONICAL_URL}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${CANONICAL_URL}">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "[Article Title]",
    "description": "[Schema description]",
    "author": {"@type": "Organization", "name": "Faux Spy"},
    "publisher": {"@type": "Organization", "name": "Faux Spy", "url": "https://www.fauxspy.com"},
    "datePublished": "${displayDate}",
    "dateModified": "${displayDate}"
  }
  </script>
  <script defer src="/_vercel/insights/script.js"></script>
  <script defer src="/_vercel/speed-insights/script.js"></script>
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
        <a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="btn btn-primary btn-small" target="_blank" rel="noopener">Add to Chrome</a>
      </div>
    </div>
  </nav>

  <div class="landing-page">
    <div class="container">
      <div style="max-width:720px;margin:0 auto;">

        <div style="margin-bottom:0.5rem;">
          <a href="/blog" style="font-size:0.875rem;color:var(--text-muted,#888);text-decoration:none;">&larr; All articles</a>
        </div>

        <div class="landing-hero" style="text-align:left;padding-left:0;">
          <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted,#888);margin-bottom:1rem;">${CATEGORY} &mdash; [Display Date like "May 30, 2026"]</div>
          <h1>[Article Title]</h1>
          <p class="landing-subtitle">[One-sentence subtitle — a concrete, honest summary of what happened or what was learned. Not a tagline.]</p>
        </div>

        [3-5 landing-section divs with h2 headings and paragraphs — 900 to 1,400 words of body content]

        <div class="landing-section" style="margin-top:2rem;padding:1.5rem;background:var(--bg-secondary,#f9f9f9);border-radius:12px;border:1px solid var(--border,#e5e5e5);">
          <h3 style="margin:0 0 0.75rem;">Try Faux Spy</h3>
          <p style="margin:0 0 1rem;font-size:0.95rem;">Right-click any image or video in Chrome to check it for AI generation. Free to use, no account required.</p>
          <a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="btn btn-primary" target="_blank" rel="noopener">Add Faux Spy to Chrome — it's free</a>
        </div>

      </div>
    </div>
  </div>

  <footer style="text-align:center;padding:2rem;color:var(--text-muted,#888);font-size:0.875rem;margin-top:4rem;border-top:1px solid var(--border,#e5e5e5);">
    <p>&copy; 2026 Faux Spy &middot; <a href="/privacy" style="color:inherit;">Privacy</a> &middot; <a href="/terms" style="color:inherit;">Terms</a></p>
  </footer>
</body>
</html>`;

  console.log('Calling Claude to generate launch article...');
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8192,
    system: [{ type: 'text', text: ARTICLE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });

  let html = message.content[0].text.trim();
  html = html.replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
  return html;
}

// ─── Revision pass ────────────────────────────────────────────────────────────

async function reviseForHumanVoice(html) {
  console.log('Running human voice revision pass...');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: [{ type: 'text', text: REVISION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `ARTICLE:\n${html}` }],
  });

  let revised = message.content[0].text.trim();
  revised = revised.replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
  return revised.startsWith('<!DOCTYPE') ? revised : html;
}

// ─── Internal link injection ─────────────────────────────────────────────────

async function injectInternalLinks(html) {
  let existingPosts;
  try {
    existingPosts = fs.readdirSync(BLOG_DIR)
      .filter(f => f.endsWith('.html') && f !== 'index.html' && f !== `${SLUG}.html`)
      .map(f => {
        const content = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
        const titleMatch = content.match(/<h1[^>]*>([^<]+)<\/h1>/);
        return { slug: f.replace('.html', ''), title: titleMatch?.[1] || f };
      });
  } catch {
    return html;
  }

  if (!existingPosts.length) return html;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Given this article HTML and the list of existing blog posts, identify 1-2 natural places to add an internal link.

Existing posts: ${JSON.stringify(existingPosts)}

For each link, return JSON: [{"anchor":"exact text in article to wrap","href":"/blog/slug"}]
Only suggest anchors that exist verbatim in the article. Return [] if no good matches.

ARTICLE: ${html.slice(0, 5000)}`,
    }],
  });

  const raw = response.content[0]?.text || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  let links = [];
  try { links = match ? JSON.parse(match[0]) : []; } catch { links = []; }

  let updated = html;
  for (const { anchor, href } of links) {
    if (!anchor || !href) continue;
    const idx = updated.indexOf(anchor);
    if (idx === -1) continue;
    const before = updated.slice(Math.max(0, idx - 300), idx);
    if (/<a\s/.test(before.split('</a>').pop())) continue;
    updated = updated.slice(0, idx) + `<a href="${href}">${anchor}</a>` + updated.slice(idx + anchor.length);
  }

  if (links.length) console.log(`  Injected ${links.length} internal link(s)`);
  return updated;
}

// ─── File system updates ──────────────────────────────────────────────────────

function addBlogCard(title, metaDesc) {
  if (!fs.existsSync(BLOG_INDEX)) {
    console.log('  blog/index.html not found — skipping card insert');
    return;
  }

  const indexHtml = fs.readFileSync(BLOG_INDEX, 'utf8');
  if (indexHtml.includes(`/blog/${SLUG}`)) {
    console.log('  Blog card already present in index.html — skipping');
    return;
  }

  const card = `
        <article class="blog-card" style="background:var(--bg-secondary,#f9f9f9);border:1px solid var(--border,#e5e5e5);border-radius:12px;padding:1.5rem;">
          <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted,#888);margin-bottom:0.5rem;">${CATEGORY}</div>
          <h2 style="font-size:1.15rem;margin:0 0 0.75rem;line-height:1.4;"><a href="/blog/${SLUG}" style="color:inherit;text-decoration:none;">${title}</a></h2>
          <p style="font-size:0.9rem;color:var(--text-muted,#666);margin:0 0 1rem;line-height:1.6;">${metaDesc.slice(0, 150)}${metaDesc.length > 150 ? '...' : ''}</p>
          <a href="/blog/${SLUG}" style="font-size:0.875rem;font-weight:600;color:var(--accent,#1a1a1a);">Read more &rarr;</a>
        </article>`;

  const gridCloseIdx = indexHtml.lastIndexOf('</div>\n\n      </div>');
  if (gridCloseIdx !== -1) {
    const updated = indexHtml.slice(0, gridCloseIdx) + card + '\n\n' + indexHtml.slice(gridCloseIdx);
    fs.writeFileSync(BLOG_INDEX, updated, 'utf8');
    console.log('  Added blog card to index.html');
  } else {
    console.log('  Could not find blog-grid closing tag — card not inserted');
  }
}

function addToSitemap() {
  if (!fs.existsSync(SITEMAP_FILE)) return;
  let xml = fs.readFileSync(SITEMAP_FILE, 'utf8');
  if (xml.includes(`<loc>${CANONICAL_URL}</loc>`)) {
    console.log('  Already in sitemap.xml');
    return;
  }
  const today = todayDate();
  const block = `  <url>\n    <loc>${CANONICAL_URL}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  xml = xml.replace('</urlset>', block + '</urlset>');
  fs.writeFileSync(SITEMAP_FILE, xml, 'utf8');
  console.log(`  Added to sitemap.xml`);
}

function addToIndexNow() {
  if (!fs.existsSync(INDEXNOW_FILE)) return;
  let indexNow = fs.readFileSync(INDEXNOW_FILE, 'utf8');
  if (indexNow.includes(`"${CANONICAL_URL}"`)) {
    console.log('  Already in indexnow.yml');
    return;
  }
  const closeIdx = indexNow.lastIndexOf('\n              ]');
  if (closeIdx !== -1) {
    indexNow = indexNow.slice(0, closeIdx) + `,\n                "${CANONICAL_URL}"` + indexNow.slice(closeIdx);
    fs.writeFileSync(INDEXNOW_FILE, indexNow, 'utf8');
    console.log(`  Added to indexnow.yml`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const outputPath = path.join(BLOG_DIR, `${SLUG}.html`);

  if (fs.existsSync(outputPath)) {
    console.error(`❌ ${outputPath} already exists. Delete it first if you want to regenerate.`);
    process.exit(1);
  }

  console.log('🕵️ Faux Spy — Product Hunt Launch Blog Agent\n');

  // Phase 1: Find and research the PH listing
  const DEFAULT_PH_URL = 'https://www.producthunt.com/products/faux-spy?launch=faux-spy';
  let phUrl = process.env.PH_URL || null;

  if (!phUrl) {
    phUrl = await discoverPHUrl();
  }
  if (!phUrl) {
    console.log(`Using default PH URL: ${DEFAULT_PH_URL}`);
    phUrl = DEFAULT_PH_URL;
  }

  let phData = null;
  if (phUrl) {
    const pageText = await fetchPHPageText(phUrl);
    phData = await parsePHData(pageText);
  }

  // Phase 2: Pick article angle based on what we found
  const angle = pickAngle(phData);
  console.log(`\nArticle angle: ${angle}`);

  // Phase 3: Generate
  const today = todayDate();
  const displayDate = formatDisplayDate(today);

  const draft = await generateArticle(displayDate, phData, angle);

  // Phase 4: Revise
  const revised = await reviseForHumanVoice(draft);

  // Phase 5: Internal links
  console.log('Injecting internal links...');
  const finalHtml = await injectInternalLinks(revised);

  // Scan for remaining AI phrases
  const foundPhrases = scanForAIPhrases(finalHtml);
  if (foundPhrases.length) {
    console.warn(`\n⚠️  AI phrases still detected: ${foundPhrases.join(', ')}`);
  } else {
    console.log('  No banned AI phrases detected.');
  }

  const title = extractTitle(finalHtml);
  const metaDesc = extractMetaDesc(finalHtml);

  console.log(`\nTitle: ${title}`);
  console.log(`Meta: ${metaDesc.slice(0, 80)}...`);

  // Save files
  console.log('');
  fs.writeFileSync(outputPath, finalHtml, 'utf8');
  console.log(`✅ Saved: blog/${SLUG}.html`);

  addBlogCard(title, metaDesc);
  addToSitemap();
  addToIndexNow();

  // Write PR summary
  const phSummary = phData
    ? [
        phData.rank && phData.rankLabel ? `- PH rank: ${phData.rank} ${phData.rankLabel}` : '',
        phData.upvotes ? `- Upvotes: ${phData.upvotes}` : '',
        phData.commentCount ? `- Comments: ${phData.commentCount}` : '',
      ].filter(Boolean).join('\n') || '- No rank data retrieved'
    : '- PH page not fetched (builder_story angle used)';

  const summary = `# New Blog Draft: ${title}

**Type:** Product Hunt Launch Post
**Angle:** ${angle}
**URL:** ${CANONICAL_URL}

## PH data used
${phSummary}

## Review checklist before merging

- [ ] Read the full article — does it sound like a real person wrote it?
- [ ] Confirm all numbers (upvotes, rank) match the actual PH listing
- [ ] Confirm any quoted comments are accurate
- [ ] Check meta description — specific and honest, no hype?
- [ ] Check H2 headings — do they make real points?
- [ ] Confirm the CTA links correctly to the Chrome Web Store
- [ ] No launch-post clichés ("thrilled to share", "humbled by the response")
${foundPhrases.length
    ? `\n⚠️ **AI phrase scanner flagged these — review manually:**\n${foundPhrases.map(p => `- \`${p}\``).join('\n')}`
    : '\n✅ AI phrase scanner: clean.'}

---
*Generated by ph-launch-blog.js — angle: ${angle}*`;

  fs.writeFileSync(path.join(SITE_ROOT, 'blog-draft-summary.md'), summary, 'utf8');
  console.log('\nPR summary saved to blog-draft-summary.md');
  console.log('\n✅ Done. Review the draft before merging.\n');
}

main().catch(err => {
  console.error('❌ Agent failed:', err.message);
  process.exit(1);
});
