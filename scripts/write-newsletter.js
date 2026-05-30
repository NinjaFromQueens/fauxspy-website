/**
 * Faux Spy Weekly Newsletter Agent
 *
 * Researches this week's content (new blog posts, product changes), writes a
 * newsletter issue via Claude, then broadcasts it to the Resend newsletter audience.
 *
 * Usage: node scripts/write-newsletter.js
 * Required env: ANTHROPIC_API_KEY, RESEND_API_KEY, NEWSLETTER_AUDIENCE_ID
 * Optional env: RESEND_FROM_EMAIL, DRY_RUN=true (write but do not send)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { default: Anthropic } = require('@anthropic-ai/sdk');

const SITE_ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(SITE_ROOT, 'blog');
const SITE_BASE = 'https://www.fauxspy.com';

const DRY_RUN = process.env.DRY_RUN === 'true';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY required');
  process.exit(1);
}
if (!DRY_RUN && !process.env.RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY required (or set DRY_RUN=true)');
  process.exit(1);
}
if (!DRY_RUN && !process.env.NEWSLETTER_AUDIENCE_ID) {
  console.error('❌ NEWSLETTER_AUDIENCE_ID required (or set DRY_RUN=true)');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function issueNumber() {
  // Week number since launch (2026-05-29)
  const launch = new Date('2026-05-29');
  const now = new Date();
  return Math.max(1, Math.round((now - launch) / (7 * 24 * 60 * 60 * 1000)));
}

// ─── Research: new blog posts this week ──────────────────────────────────────

function getNewBlogPosts() {
  try {
    // Find blog HTML files committed in the last 7 days via git log
    const raw = execSync(
      'git log --since="7 days ago" --name-only --pretty=format: -- blog/',
      { encoding: 'utf8', cwd: SITE_ROOT }
    ).trim();

    const files = [...new Set(
      raw.split('\n')
        .map(l => l.trim())
        .filter(l => l.endsWith('.html') && !l.endsWith('index.html'))
    )];

    return files.map(f => {
      const fullPath = path.join(SITE_ROOT, f);
      if (!fs.existsSync(fullPath)) return null;
      const html = fs.readFileSync(fullPath, 'utf8');
      const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() || '';
      const desc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1]?.trim() || '';
      const slug = path.basename(f, '.html');
      return title ? { title, description: desc, url: `${SITE_BASE}/blog/${slug}` } : null;
    }).filter(Boolean);
  } catch (e) {
    console.warn('Could not read git log for blog posts:', e.message);
    return [];
  }
}

// ─── Research: product changes this week ─────────────────────────────────────

function getProductCommits() {
  try {
    const raw = execSync(
      'git log --oneline --since="7 days ago" --no-merges',
      { encoding: 'utf8', cwd: SITE_ROOT }
    ).trim();

    return raw.split('\n')
      .map(l => l.replace(/^[a-f0-9]+ /, '').trim())
      .filter(l =>
        l &&
        !l.includes('[skip ci]') &&
        !l.startsWith('chore:') &&
        !l.match(/\b(bot|auto|cron)\b/i)
      )
      .slice(0, 6);
  } catch (e) {
    console.warn('Could not read git log:', e.message);
    return [];
  }
}

// ─── Research: subscriber count ───────────────────────────────────────────────

async function getSubscriberCount() {
  const audienceId = process.env.NEWSLETTER_AUDIENCE_ID;
  const apiKey = process.env.RESEND_API_KEY;
  if (!audienceId || !apiKey) return null;

  try {
    const resp = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data?.data || []).filter(c => !c.unsubscribed).length;
  } catch {
    return null;
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const NEWSLETTER_SYSTEM_PROMPT = `You are writing a weekly newsletter for Faux Spy, a Chrome extension that detects AI-generated images and videos.

NEWSLETTER VOICE: Direct, knowledgeable, not corporate. The reader is smart and doesn't want to be talked down to. You know the scam world cold. Write like you're telling a friend something they need to know — not like a marketing email.

FORMAT: Return a JSON object with two fields:
- "subject": the email subject line (max 55 chars, specific and punchy — not clickbait, not vague)
- "html": the complete newsletter HTML (email-compatible inline styles, no external stylesheets)

HTML STRUCTURE:
1. Header: Faux Spy logo + "Issue #N — [Month Day, Year]"
2. Lead story (2–3 paragraphs): The most important AI scam or deepfake story from this week. If no external news is provided, write about a real, relevant tactic or pattern currently affecting people. Be specific — name platforms, tactics, dollar amounts where possible.
3. New on the blog (only if blog posts are provided): Brief 1–2 sentence tease for each new post with a link.
4. Tip of the week: One specific, immediately actionable thing. Not "be careful online" — something concrete like "check the profile photo before you reply, here's how."
5. Footer with unsubscribe link.

HTML RULES:
- All styles must be inline (email clients strip head styles)
- Max width 600px, centered
- Background: white (#ffffff) for email client compatibility
- Text: #1a1f2e (near-black)
- Accent/links: #d97706 (gold-dark)
- Use the Resend variable {{unsubscribe_url}} in the unsubscribe link — Resend replaces it automatically
- No images (they get blocked in many email clients)
- Keep it under 700 words of visible text

BANNED PHRASES: "it's worth noting", "furthermore", "in conclusion", "cutting-edge", "game-changing", "excited to share", "we are thrilled", "in today's digital age", "delve into", "comprehensive"

Return ONLY the JSON object. No markdown fences, no explanation.`;

// ─── Generate newsletter ──────────────────────────────────────────────────────

async function generateNewsletter(context) {
  console.log('Calling Claude to write newsletter...');

  const userPrompt = `Write this week's Faux Spy newsletter.

ISSUE: #${issueNumber()}
DATE: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
${context.subscriberCount !== null ? `SUBSCRIBERS: ${context.subscriberCount} active` : ''}

${context.newPosts.length > 0 ? `NEW BLOG POSTS THIS WEEK:
${context.newPosts.map(p => `- "${p.title}"\n  ${p.description}\n  ${p.url}`).join('\n')}` : 'No new blog posts this week.'}

${context.productCommits.length > 0 ? `PRODUCT CHANGES THIS WEEK (git commits):
${context.productCommits.map(c => `- ${c}`).join('\n')}` : 'No notable product changes this week.'}

Write the newsletter now. Return only the JSON object {"subject":"...","html":"..."}.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    system: [{ type: 'text', text: NEWSLETTER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].text.trim();
  // Strip markdown fences if model adds them
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Attempt to extract JSON object if there's surrounding text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse Claude response as JSON: ${cleaned.slice(0, 200)}`);
  }
}

// ─── Send via Resend broadcasts API ──────────────────────────────────────────

async function sendNewsletter(subject, html, issueNum) {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.NEWSLETTER_AUDIENCE_ID;
  const from = process.env.RESEND_FROM_EMAIL || 'Faux Spy <hello@fauxspy.com>';
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const today = todayDate();

  console.log('Creating Resend broadcast...');
  const createResp = await fetch('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      audience_id: audienceId,
      from,
      subject,
      html,
      name: `Faux Spy Briefing #${issueNum} — ${today}`,
    }),
  });

  const createData = await createResp.json();
  if (!createResp.ok) {
    throw new Error(`Broadcast create failed: ${JSON.stringify(createData)}`);
  }
  const broadcastId = createData.id;
  console.log(`  Broadcast created: ${broadcastId}`);

  console.log('Sending broadcast...');
  const sendResp = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({}),
  });

  const sendData = await sendResp.json();
  if (!sendResp.ok) {
    throw new Error(`Broadcast send failed: ${JSON.stringify(sendData)}`);
  }

  return broadcastId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const issueNum = issueNumber();
  console.log(`📬 Faux Spy Newsletter Agent — Issue #${issueNum}\n`);
  if (DRY_RUN) console.log('DRY RUN — newsletter will be written but not sent\n');

  // Phase 1: Research
  console.log('Researching this week\'s content...');
  const newPosts = getNewBlogPosts();
  const productCommits = getProductCommits();
  const subscriberCount = await getSubscriberCount();

  console.log(`  New blog posts: ${newPosts.length}`);
  console.log(`  Product commits: ${productCommits.length}`);
  if (subscriberCount !== null) console.log(`  Active subscribers: ${subscriberCount}`);

  if (!DRY_RUN && subscriberCount === 0) {
    console.warn('\n⚠️  No subscribers in audience — skipping send.');
    process.exit(0);
  }

  // Phase 2: Generate
  const newsletter = await generateNewsletter({ newPosts, productCommits, subscriberCount });

  console.log(`\nSubject: ${newsletter.subject}`);
  console.log(`HTML length: ${newsletter.html.length} chars`);

  // Save draft for inspection
  const draftPath = path.join(SITE_ROOT, 'newsletter-draft.html');
  fs.writeFileSync(draftPath, newsletter.html, 'utf8');
  console.log(`\nDraft saved: newsletter-draft.html`);

  // Phase 3: Send (or skip if dry run)
  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. Review newsletter-draft.html before sending.\n');
    return;
  }

  const broadcastId = await sendNewsletter(newsletter.subject, newsletter.html, issueNum);

  const summary = `# Newsletter Sent — Issue #${issueNum}

**Date:** ${todayDate()}
**Subject:** ${newsletter.subject}
**Broadcast ID:** ${broadcastId}
**Subscribers:** ${subscriberCount ?? 'unknown'}
**New blog posts included:** ${newPosts.length}

${newPosts.length > 0 ? newPosts.map(p => `- [${p.title}](${p.url})`).join('\n') : '_None_'}
`;

  fs.writeFileSync(path.join(SITE_ROOT, 'newsletter-sent.md'), summary, 'utf8');
  console.log('\n✅ Newsletter sent.\n');
}

main().catch(err => {
  console.error('❌ Newsletter agent failed:', err.message);
  process.exit(1);
});
