/**
 * Faux Spy Blog Draft Generator (G)
 * Generates a full blog article HTML file from a topic input and opens a PR for review.
 * Never auto-merges — content always requires human approval before publishing.
 *
 * Usage: BLOG_TOPIC="..." BLOG_CATEGORY="..." node scripts/seo-blog-draft.js
 * Required env: ANTHROPIC_API_KEY, BLOG_TOPIC
 * Optional env: BLOG_CATEGORY (defaults to "AI Detection")
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { default: Anthropic } = require('@anthropic-ai/sdk');

const SITE_ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(SITE_ROOT, 'blog');
const BLOG_INDEX = path.join(BLOG_DIR, 'index.html');
const SITEMAP_FILE = path.join(SITE_ROOT, 'sitemap.xml');
const INDEXNOW_FILE = path.join(SITE_ROOT, '.github', 'workflows', 'indexnow.yml');
const SITE_BASE = 'https://fauxspy.com';

const topic = process.env.BLOG_TOPIC;
const category = process.env.BLOG_CATEGORY || 'AI Detection';

if (!topic) {
  console.error('❌ BLOG_TOPIC env var is required.');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY env var is required.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function topicToSlug(t) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

function formatDisplayDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Banned phrase list (used by both prompt and scanner) ────────────────────

const BANNED_PHRASES = [
  "it's worth noting", "it's important to note", "delve into", "navigate",
  "in the realm of", "furthermore", "in conclusion", "in summary", "as we've seen",
  "when it comes to", "let's explore", "let's dive in", "it goes without saying",
  "at the end of the day", "cutting-edge", "game-changing", "groundbreaking",
  "needless to say", "a comprehensive guide", "in today's digital age",
  "the importance of", "this article will", "we will cover", "in this post",
  "additionally,", "moreover,", "it is worth", "it should be noted",
  "in order to", "as mentioned", "as noted",
];

// ─── SerpAPI research pass ────────────────────────────────────────────────────

async function researchTopic(t) {
  if (!process.env.SERPAPI_KEY) {
    console.log('  SERPAPI_KEY not set — skipping pre-research (article will still generate)');
    return null;
  }

  console.log('Researching topic via SerpAPI...');
  const params = new URLSearchParams({
    q: t,
    api_key: process.env.SERPAPI_KEY,
    num: '5',
    hl: 'en',
    gl: 'us',
  });

  let data;
  try {
    const resp = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`SerpAPI ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    console.warn(`  Research failed: ${err.message} — continuing without`);
    return null;
  }

  const snippets = (data.organic_results || [])
    .slice(0, 5)
    .map(r => r.snippet)
    .filter(Boolean);

  const relatedQuestions = (data.related_questions || [])
    .slice(0, 6)
    .map(q => q.question)
    .filter(Boolean);

  const answerBox = data.answer_box?.answer || data.answer_box?.snippet || null;

  // Fetch and extract text from top 3 pages for real data points
  const organicResults = (data.organic_results || []).slice(0, 3);
  const pageExcerpts = [];

  for (const result of organicResults) {
    try {
      const pageResp = await fetch(result.link, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': 'fauxspy-research:v1.0 (contact: duroneppsjr7@gmail.com)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });
      if (pageResp.ok) {
        const raw = await pageResp.text();
        // Strip scripts/styles first, then tags
        const clean = raw
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '');
        const text = stripTags(clean).replace(/\s+/g, ' ').trim().slice(0, 1200);
        if (text.length > 200) {
          pageExcerpts.push({ title: result.title, url: result.link, text });
        }
      }
    } catch { /* skip unreachable pages */ }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`  Found: ${snippets.length} snippets, ${relatedQuestions.length} related Qs, ${pageExcerpts.length} pages`);

  return { snippets, relatedQuestions, answerBox, pageExcerpts };
}

function buildResearchContext(research) {
  if (!research) return '';

  const parts = ['RESEARCH MATERIAL — ground your article in these real facts and reader questions:\n'];

  if (research.answerBox) {
    parts.push(`Featured answer box:\n"${research.answerBox}"\n`);
  }

  if (research.snippets.length) {
    parts.push(`Top search result snippets (may contain useful statistics or context):\n` +
      research.snippets.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n');
  }

  if (research.relatedQuestions.length) {
    parts.push(`What people are actually searching for on this topic:\n` +
      research.relatedQuestions.map(q => `- ${q}`).join('\n') + '\n');
  }

  if (research.pageExcerpts.length) {
    parts.push(`Content from top-ranking pages (for context — do NOT copy, use to understand what's already covered and write something better):\n` +
      research.pageExcerpts.map(p => `[${p.title}]\n${p.text}`).join('\n\n'));
  }

  parts.push('\nYou MUST use at least 2 specific, verifiable data points from this research. If the research contains statistics with sources, cite them. If not, acknowledge what is and isn\'t known.\n');

  return parts.join('\n');
}

// ─── Programmatic AI-phrase scanner ──────────────────────────────────────────

function scanForAIPhrases(html) {
  const text = stripTags(html).toLowerCase();
  return BANNED_PHRASES.filter(p => text.includes(p.toLowerCase()));
}

// ─── Read style examples from existing articles ───────────────────────────────

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function readStyleExamples() {
  let files;
  try {
    files = fs.readdirSync(BLOG_DIR)
      .filter(f => f.endsWith('.html') && f !== 'index.html')
      .slice(0, 4);
  } catch {
    return [];
  }

  const examples = [];
  for (const file of files) {
    const html = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
    // Extract clean prose from each landing-section (strip all HTML tags first)
    const sections = [...html.matchAll(/<div class="landing-section">([\s\S]*?)<\/div>/g)]
      .slice(0, 3)
      .map(m => stripTags(m[1]).slice(0, 600))
      .filter(s => s.length > 100);
    if (sections.length) examples.push({ file, sections });
  }
  return examples;
}

// ─── Generate article via Claude ──────────────────────────────────────────────

async function generateArticle(slug, displayDate, research) {
  const examples = readStyleExamples();
  const styleContext = examples.length > 0
    ? `Here are prose excerpts from existing Faux Spy articles — study the tone, rhythm, and directness:\n\n` +
      examples.map(e =>
        `--- ${e.file} ---\n${e.sections.join('\n\n')}`
      ).join('\n\n')
    : '';

  const researchContext = buildResearchContext(research);

  const prompt = `You are writing a blog article for Faux Spy, a Chrome extension that detects AI-generated images and videos.

${styleContext}

${researchContext}
Write a complete, in-depth blog article about: "${topic}"
Category: ${category}

AUTHOR VOICE: You are writing in the voice of someone who built FauxSpy after watching people get burned by fake profiles. This person is direct, a little blunt, and genuinely cares about the problem. They've seen the screenshots. They know how the scams work technically. They don't moralize or over-explain. They respect the reader's intelligence.

CRITICAL WRITING RULES — every single one applies:
- Write like a person, not like an AI. No bullet-pointed summaries of what the article will cover. No "In this article, we will explore..." openers.
- Start with a specific scene, statistic, or concrete observation — not with a definition or a statement about how important the topic is.
- Short paragraphs. 3–4 sentences max. Vary the rhythm — mix long and short sentences. Use a single short sentence (under 10 words) as its own paragraph at least twice for punch.
- Use second person ("you") throughout. Talk directly to the reader.
- Each H2 heading must make a real point, not just label a category. "How to spot it" is weak. "The tell is in the hand movement, not the face" is strong.
- Include at least one specific, verifiable data point per major section — a real statistic, a named source, a specific dollar amount or percentage.
- Name specific real platforms, apps, or websites when giving examples (Tinder, r/OnlineDating, Hinge, etc.) — not vague "dating apps."
- Contradict a common assumption at least once. "Most people think X. They're wrong."
- Write at least one sentence that starts with "And" or "But" — real writers do this.
- No fluff. If a sentence doesn't add information, cut it.
- Aim for 1,200–1,800 words of article body content.

BANNED PHRASES — never use any of these:
"it's worth noting", "it's important to note", "delve into", "navigate", "in the realm of", "furthermore", "in conclusion", "in summary", "as we've seen", "when it comes to", "let's explore", "let's dive in", "it goes without saying", "at the end of the day", "cutting-edge", "game-changing", "groundbreaking", "needless to say", "a comprehensive guide", "in today's digital age", "the importance of", "This article will", "we will cover", "in this post"

Output a complete HTML article file using EXACTLY this structure — replace the placeholder values:

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Article Title] | Faux Spy Blog</title>
  <meta name="description" content="[130-155 character meta description — specific, not generic]">
  <meta property="og:title" content="[Article Title]">
  <meta property="og:description" content="[OG description — same as meta or variation]">
  <meta property="og:image" content="https://fauxspy.com/og-image.png">
  <meta property="og:url" content="${SITE_BASE}/blog/${slug}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${SITE_BASE}/blog/${slug}">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "[Article Title]",
    "description": "[Schema description]",
    "author": {"@type": "Organization", "name": "Faux Spy"},
    "publisher": {"@type": "Organization", "name": "Faux Spy", "url": "https://fauxspy.com"},
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
          <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted,#888);margin-bottom:1rem;">${category} &mdash; [Display Date]</div>
          <h1>[Article Title]</h1>
          <p class="landing-subtitle">[One-sentence subtitle — a specific, interesting claim that makes someone want to keep reading. Not a summary of the article.]</p>
        </div>

        [2-4 landing-section divs with h2 headings and paragraphs]

        <div class="landing-section" style="margin-top:2rem;padding:1.5rem;background:var(--bg-secondary,#f9f9f9);border-radius:12px;border:1px solid var(--border,#e5e5e5);">
          <h3 style="margin:0 0 0.75rem;">Check any image or video with Faux Spy</h3>
          <p style="margin:0 0 1rem;font-size:0.95rem;">Right-click any photo or video in your browser to run it through AI detection in seconds. No upload needed.</p>
          <a href="https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg" class="btn btn-primary" target="_blank" rel="noopener">Add Faux Spy to Chrome — it's free</a>
        </div>

      </div>
    </div>
  </div>

  <footer style="text-align:center;padding:2rem;color:var(--text-muted,#888);font-size:0.875rem;margin-top:4rem;border-top:1px solid var(--border,#e5e5e5);">
    <p>&copy; 2026 Faux Spy &middot; <a href="/privacy" style="color:inherit;">Privacy</a> &middot; <a href="/terms" style="color:inherit;">Terms</a></p>
  </footer>
</body>
</html>
\`\`\`

Return ONLY the complete HTML. No explanation before or after. No markdown code fences in your output — just the raw HTML starting with <!DOCTYPE html>.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  let html = message.content[0].text.trim();
  // Strip markdown fences if the model added them
  html = html.replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
  return html;
}

// ─── Revision pass: hunt and fix AI-sounding phrases ─────────────────────────

async function reviseForHumanVoice(html) {
  console.log('Running human voice revision pass...');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `You are a sharp human editor. Your only job is to find and fix AI-sounding text in this blog article.

Find sentences or phrases that sound generic, formulaic, hedging, or AI-written. Rewrite ONLY those — keep everything else exactly as-is, including all HTML tags, structure, and attributes.

Common AI tells to hunt for:
- Topic sentences that just label a category instead of making a real point
- Transitions like "furthermore", "additionally", "it's important to note", "it's worth noting"
- Sentences that hedge when they should just say the thing directly
- Closing sentences that summarise what was just said
- Introductory clauses that delay getting to the point ("When it comes to X...", "In the world of...")
- Any phrase from this banned list: "delve into", "navigate", "in the realm of", "cutting-edge", "game-changing", "groundbreaking", "in today's digital age", "comprehensive"

Return the complete HTML with your edits applied. No explanation before or after — just the corrected HTML starting with <!DOCTYPE html>.

ARTICLE:
${html}`
    }],
  });

  let revised = message.content[0].text.trim();
  revised = revised.replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
  // Safety fallback: if revision produced something that doesn't look like HTML, keep original
  return revised.startsWith('<!DOCTYPE') ? revised : html;
}

// ─── Extract title from generated HTML ────────────────────────────────────────

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  return m ? m[1].trim() : topic;
}

function extractMetaDesc(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  return m ? m[1].trim() : '';
}

// ─── Add card to blog/index.html ──────────────────────────────────────────────

function addBlogCard(slug, title, metaDesc, displayDate) {
  if (!fs.existsSync(BLOG_INDEX)) {
    console.log('  ⚠️  blog/index.html not found — skipping card insert');
    return;
  }

  const indexHtml = fs.readFileSync(BLOG_INDEX, 'utf8');

  // Insert new card before the closing </div> of .blog-grid
  const card = `
        <article class="blog-card" style="background:var(--bg-secondary,#f9f9f9);border:1px solid var(--border,#e5e5e5);border-radius:12px;padding:1.5rem;">
          <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted,#888);margin-bottom:0.5rem;">${category}</div>
          <h2 style="font-size:1.15rem;margin:0 0 0.75rem;line-height:1.4;"><a href="/blog/${slug}" style="color:inherit;text-decoration:none;">${title}</a></h2>
          <p style="font-size:0.9rem;color:var(--text-muted,#666);margin:0 0 1rem;line-height:1.6;">${metaDesc.slice(0, 150)}${metaDesc.length > 150 ? '...' : ''}</p>
          <a href="/blog/${slug}" style="font-size:0.875rem;font-weight:600;color:var(--accent,#1a1a1a);">Read more &rarr;</a>
        </article>`;

  // Find the closing </div> that wraps the blog-grid
  const gridCloseIdx = indexHtml.lastIndexOf('</div>\n\n      </div>');
  if (gridCloseIdx !== -1) {
    const updated = indexHtml.slice(0, gridCloseIdx) + card + '\n\n' + indexHtml.slice(gridCloseIdx);
    fs.writeFileSync(BLOG_INDEX, updated, 'utf8');
    console.log(`  📋 Added blog card to index.html`);
  } else {
    console.log('  ⚠️  Could not find blog-grid closing tag — card not inserted automatically');
  }
}

// ─── Add to sitemap.xml ───────────────────────────────────────────────────────

function addToSitemap(url) {
  if (!fs.existsSync(SITEMAP_FILE)) return;
  let xml = fs.readFileSync(SITEMAP_FILE, 'utf8');
  if (xml.includes(`<loc>${url}</loc>`)) return;

  const today = todayDate();
  const block = `  <url>\n    <loc>${url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  xml = xml.replace('</urlset>', block + '</urlset>');
  fs.writeFileSync(SITEMAP_FILE, xml, 'utf8');
  console.log(`  🗺️  Added to sitemap.xml: ${url}`);
}

// ─── Add to indexnow.yml ──────────────────────────────────────────────────────

function addToIndexNow(url) {
  if (!fs.existsSync(INDEXNOW_FILE)) return;
  let indexNow = fs.readFileSync(INDEXNOW_FILE, 'utf8');
  if (indexNow.includes(`"${url}"`)) return;

  const closeIdx = indexNow.lastIndexOf('\n              ]');
  if (closeIdx !== -1) {
    indexNow =
      indexNow.slice(0, closeIdx) +
      `,\n                "${url}"` +
      indexNow.slice(closeIdx);
    fs.writeFileSync(INDEXNOW_FILE, indexNow, 'utf8');
    console.log(`  📡  Added to indexnow.yml: ${url}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const slug = topicToSlug(topic);
  const today = todayDate();
  const displayDate = formatDisplayDate(today);
  const outputPath = path.join(BLOG_DIR, `${slug}.html`);
  const canonicalUrl = `${SITE_BASE}/blog/${slug}`;

  if (fs.existsSync(outputPath)) {
    console.error(`❌ ${outputPath} already exists. Choose a different topic or delete the file first.`);
    process.exit(1);
  }

  console.log(`📝 Generating blog article: "${topic}"\n`);
  console.log(`  Slug: ${slug}`);
  console.log(`  Output: blog/${slug}.html\n`);

  const research = await researchTopic(topic);

  console.log('Calling Claude to generate article...');
  const draft = await generateArticle(slug, today, research);

  const html = await reviseForHumanVoice(draft);

  const foundPhrases = scanForAIPhrases(html);
  if (foundPhrases.length) {
    console.warn(`\n  ⚠️  AI phrases still detected after revision: ${foundPhrases.join(', ')}`);
  } else {
    console.log('  ✅ No banned AI phrases detected.');
  }

  const title = extractTitle(html);
  const metaDesc = extractMetaDesc(html);

  console.log(`  Title: ${title}`);
  console.log(`  Meta desc: ${metaDesc.slice(0, 80)}...\n`);

  // Save article file
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`  ✅ Saved: blog/${slug}.html`);

  // Add card to blog index
  addBlogCard(slug, title, metaDesc, displayDate);

  // Add to sitemap and indexnow
  addToSitemap(canonicalUrl);
  addToIndexNow(canonicalUrl);

  // Write summary for PR body
  const summary = `# New Blog Draft: ${title}

**Topic:** ${topic}
**Category:** ${category}
**Slug:** \`blog/${slug}\`
**URL:** ${canonicalUrl}

## Review checklist before merging

- [ ] Read the full article — does it sound like a real person wrote it?
- [ ] Check all facts and statistics — are they accurate and current?
- [ ] Confirm the meta description is specific and compelling (not generic)
- [ ] Check H2 headings — are they descriptive and not just category labels?
- [ ] Confirm the CTA at the bottom links correctly
- [ ] Review the blog card on \`/blog\` — does the excerpt make sense?
- [ ] No accidental AI writing patterns (lists of what the article will cover, "Furthermore", "In conclusion", etc.)
${foundPhrases.length
    ? `\n⚠️ **AI phrase scanner flagged these — review manually:**\n${foundPhrases.map(p => `- \`${p}\``).join('\n')}`
    : '\n✅ AI phrase scanner: no banned phrases detected.'}

---
*Generated by Faux Spy Blog Draft Agent*`;

  fs.writeFileSync(path.join(SITE_ROOT, 'blog-draft-summary.md'), summary, 'utf8');
  console.log('\n  PR summary saved to blog-draft-summary.md');
  console.log('\n✅ Done. Review the draft before merging the PR.\n');
}

main().catch(err => {
  console.error('Blog draft generation failed:', err.message);
  process.exit(1);
});
