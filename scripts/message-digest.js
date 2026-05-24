/**
 * Faux Spy User Message Digest
 * Reads last 7 days of contact messages and waitlist signups via the admin API,
 * uses Claude to categorize them into themes, and posts a GitHub Issue.
 *
 * Usage: node scripts/message-digest.js
 * Required env: ADMIN_TOKEN, ANTHROPIC_API_KEY, GH_TOKEN (auto-set in GitHub Actions)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { default: Anthropic } = require('@anthropic-ai/sdk');

const REPO = 'NinjaFromQueens/fauxspy-website';
const ADMIN_BASE = 'https://fauxspy.com/api/admin';

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `digest-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function fetchAdmin(endpoint) {
  const resp = await fetch(`${ADMIN_BASE}/${endpoint}?token=${process.env.ADMIN_TOKEN}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Admin API returned ${resp.status} for ${endpoint}`);
  return resp.json();
}

async function main() {
  if (!process.env.ADMIN_TOKEN) {
    console.error('❌ ADMIN_TOKEN is required');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log('📬 Fetching user messages and waitlist...\n');

  // Fetch contact submissions
  const contactData = await fetchAdmin('contact');
  const allMessages = contactData.submissions || [];
  const recentMessages = allMessages.filter(m => m.timestamp >= weekAgo);
  console.log(`  Contact messages (7d): ${recentMessages.length} of ${allMessages.length} total`);

  // Fetch waitlist
  const waitlistData = await fetchAdmin('waitlist');
  const allWaitlist = waitlistData.signups || waitlistData.waitlist || [];
  const recentWaitlist = allWaitlist.filter(w => w.timestamp >= weekAgo);
  console.log(`  Waitlist signups (7d): ${recentWaitlist.length} of ${allWaitlist.length} total`);

  // If nothing new this week, skip the issue
  if (recentMessages.length === 0 && recentWaitlist.length === 0) {
    console.log('\nNo new activity this week — skipping issue.');
    return;
  }

  let themeSection = '';

  if (recentMessages.length > 0) {
    // Prepare messages for Claude (anonymized — no email addresses)
    const messageSummary = recentMessages.map((m, i) =>
      `[${i + 1}] Topic: ${m.topic || 'General'}\nMessage: ${(m.message || '').slice(0, 500)}`
    ).join('\n\n');

    console.log('\nCalling Claude to categorize messages...');
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are analyzing user support messages for Faux Spy, a Chrome extension that detects AI-generated images and videos.

Here are ${recentMessages.length} messages from the past 7 days:

${messageSummary}

Group them into 3-5 themes. For each theme:
- Give it a short name (e.g. "Detection accuracy", "X/Twitter support", "Pricing confusion")
- Count how many messages fit
- Quote one short representative excerpt (anonymized — no names or emails)

Then add a "Key issues" section with 2-3 bullet points of what needs attention.

Write plainly. No intro fluff. Just the themes and key issues.`,
      }],
    });

    themeSection = response.content[0].text;
  }

  // Build topic breakdown (from form field, no Claude needed)
  const topicCounts = {};
  recentMessages.forEach(m => {
    const t = m.topic || 'General';
    topicCounts[t] = (topicCounts[t] || 0) + 1;
  });
  const topicRows = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => `| ${topic} | ${count} |`)
    .join('\n');

  // Waitlist source breakdown
  const sourceCounts = {};
  recentWaitlist.forEach(w => {
    const s = w.source || 'direct';
    sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  });
  const sourceRows = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([src, count]) => `| ${src} | ${count} |`)
    .join('\n');

  const body = `# User Digest — ${today}

## At a Glance

| | This week | All time |
|-|-----------|----------|
| Contact messages | **${recentMessages.length}** | ${allMessages.length} |
| Waitlist signups | **${recentWaitlist.length}** | ${allWaitlist.length} |

${recentMessages.length > 0 ? `## Message Topics

| Topic | Count |
|-------|-------|
${topicRows || '| — | — |'}
` : ''}
${recentWaitlist.length > 0 ? `## Waitlist Sources

| Source | Count |
|--------|-------|
${sourceRows || '| — | — |'}
` : ''}
${themeSection ? `## Theme Analysis (Claude)\n\n${themeSection}` : ''}

---
*Generated by Faux Spy Message Digest · ${today} · [View admin panel](https://fauxspy.com/admin)*`;

  console.log('\nPosting GitHub Issue...');
  ghWithFile(`issue create --title "User Digest — ${today}"`, body);
  console.log('✅ Done.');
}

main().catch(err => {
  console.error('Message digest failed:', err.message);
  process.exit(1);
});
