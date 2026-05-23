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

// ─── Read style examples from existing articles ───────────────────────────────

function readStyleExamples() {
  const sampleFiles = [
    'how-to-tell-if-video-is-ai-generated.html',
    'signs-someone-is-catfishing-you.html',
    'deepfake-fraud-statistics.html',
  ];

  const examples = [];
  for (const file of sampleFiles) {
    const filePath = path.join(BLOG_DIR, file);
    if (fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, 'utf8');
      // Extract just the article body (between landing-section divs)
      const bodyMatch = html.match(/<div class="landing-section">([\s\S]*?)<\/div>\s*\n\s*<div class="landing-section">/);
      const excerpt = bodyMatch ? bodyMatch[0].slice(0, 800) : html.slice(0, 800);
      examples.push({ file, excerpt });
    }
  }
  return examples;
}

// ─── Generate article via Claude ──────────────────────────────────────────────

async function generateArticle(slug, displayDate) {
  const examples = readStyleExamples();
  const styleContext = examples.length > 0
    ? `Here are excerpts from existing Faux Spy articles to show you the tone and style:\n\n` +
      examples.map(e => `--- ${e.file} ---\n${e.excerpt}`).join('\n\n')
    : '';

  const prompt = `You are writing a blog article for Faux Spy, a Chrome extension that detects AI-generated images and videos.

${styleContext}

Write a complete, in-depth blog article about: "${topic}"
Category: ${category}

CRITICAL WRITING RULES — you must follow every one of these:
- Write like a person, not like an AI. No bullet-pointed summaries of what the article will cover. No "In this article, we will explore..." openers. No formulaic transitions like "Furthermore" or "In conclusion."
- Start with a specific scene, statistic, or concrete observation — not with a definition or a statement about how important the topic is.
- Short paragraphs. 3-4 sentences max per paragraph. Vary the rhythm — mix long and short sentences within paragraphs.
- Use second person ("you") throughout. Talk directly to the reader.
- Each H2 section should have a real point, not just a category label. "How to spot it" is weak. "The tell is in the hand movement, not the face" is strong.
- Include at least one specific, verifiable data point per major section (statistics, study findings, or named real-world examples).
- No fluff. If a sentence doesn't add information, cut it.
- Aim for 1,200–1,800 words of article body content.

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

  console.log('Calling Claude to generate article...');
  const html = await generateArticle(slug, today);

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
