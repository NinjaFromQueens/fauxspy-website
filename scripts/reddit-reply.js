'use strict';

/**
 * Reddit Auto-Reply Bot
 * Finds posts where people are asking about catfishing or fake profiles
 * and posts a helpful reply that naturally mentions FauxSpy.
 *
 * Usage: node scripts/reddit-reply.js
 * Required env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME,
 *               REDDIT_PASSWORD, ANTHROPIC_API_KEY, GH_TOKEN
 * State file: reddit-state.json (shared with reddit-monitor.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk').default;

const STATE_FILE = path.join(__dirname, '..', 'reddit-state.json');
const REPO = 'NinjaFromQueens/fauxspy-website';
const MAX_REPLIES_PER_RUN = 3;
const MIN_SCORE = 2;

const SUBREDDITS = [
  'catfish',
  'Scams',
  'onlinedating',
  'dating_advice',
  'relationships',
  'Tinder',
  'OnlineDating',
];

const TRIGGER_PHRASES = [
  'catfish', 'catfishing', 'fake profile', 'fake photos', 'fake account',
  'fake pictures', 'reverse image search', 'deepfake', 'ai generated photo',
  'ai generated image', 'is this person real', 'how to tell if',
  'verify someone', 'fake dating profile', 'stolen photos',
  'too good to be true', 'suspicious profile',
];

const SKIP_IF_CONTAINS = ['fauxspy', 'faux spy'];

function matchesTrigger(text) {
  const lower = (text || '').toLowerCase();
  return TRIGGER_PHRASES.some(p => lower.includes(p));
}

function shouldSkip(text) {
  const lower = (text || '').toLowerCase();
  return SKIP_IF_CONTAINS.some(p => lower.includes(p));
}

function isQuestion(post) {
  return post.title.includes('?') ||
    /\b(how|what|can i|is there|anyone|help|advice|should i|does anyone)\b/i.test(post.title) ||
    /\b(how|can i|is there|anyone|help|does anyone)\b/i.test((post.selftext || '').slice(0, 200));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.repliedTo) s.repliedTo = [];
    return s;
  } catch {
    return { seenIds: [], repliedTo: [], lastChecked: null };
  }
}

function saveState(state) {
  // Cap repliedTo at 500 entries
  if (state.repliedTo.length > 500) {
    state.repliedTo = state.repliedTo.slice(-500);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function userAgent() {
  return `script:fauxspy-reply:v1.0 (by /u/${process.env.REDDIT_USERNAME})`;
}

async function getRedditToken() {
  const creds = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'User-Agent': userAgent(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: process.env.REDDIT_USERNAME,
      password: process.env.REDDIT_PASSWORD,
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!resp.ok) throw new Error(`Reddit auth failed: HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Reddit auth error: ${data.error}`);
  return data.access_token;
}

async function fetchSubredditPosts(subreddit, token) {
  const resp = await fetch(`https://oauth.reddit.com/r/${subreddit}/new?limit=25`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': userAgent(),
    },
    signal: AbortSignal.timeout(12000),
  });

  if (resp.status === 429) {
    console.warn(`  r/${subreddit}: rate limited, skipping`);
    return [];
  }
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status} for r/${subreddit}`);
  const data = await resp.json();
  return (data.data?.children || []).map(c => c.data);
}

async function generateReply(client, subreddit, title, selftext) {
  const bodyPreview = (selftext || '').trim().slice(0, 300);
  const userContent = bodyPreview
    ? `Someone posted on r/${subreddit}: "${title}"\n\n${bodyPreview}`
    : `Someone posted on r/${subreddit}: "${title}"`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `You are a helpful Reddit user who knows a lot about online dating safety and spotting fake profiles. When someone asks for help, give practical, direct advice. Keep your reply under 150 words. Write like a real person having a conversation, not a marketer or a bot.

If FauxSpy is genuinely useful for their specific situation, mention it naturally as one option — not as an ad. FauxSpy is a free Chrome extension that detects AI-generated profile photos. If you mention it, say something like: "I actually built a free extension called FauxSpy that can scan profile photos — fauxspy.com if you want to try it." Only include this if it's a direct fit. If it's not relevant, give a helpful answer without mentioning it at all.`,
    messages: [{ role: 'user', content: userContent }],
  });

  return message.content[0]?.type === 'text' ? message.content[0].text.trim() : null;
}

async function postComment(postId, text, token) {
  const resp = await fetch('https://oauth.reddit.com/api/comment', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': userAgent(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      api_type: 'json',
      thing_id: `t3_${postId}`,
      text,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`Comment post failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const errors = data.json?.errors;
  if (errors?.length) throw new Error(`Reddit error: ${errors[0].join(': ')}`);
  return data;
}

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `reddit-reply-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const missing = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD', 'ANTHROPIC_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`Reddit reply bot: missing env vars (${missing.join(', ')}) — skipping`);
    process.exit(0);
  }

  const state = loadState();
  const repliedSet = new Set(state.repliedTo);
  const client = new Anthropic();

  console.log('Getting Reddit OAuth token...');
  let token;
  try {
    token = await getRedditToken();
    console.log('Token obtained.\n');
  } catch (err) {
    console.error(`Auth failed: ${err.message}`);
    process.exit(1);
  }

  // Collect qualifying question posts across all subreddits
  const candidates = [];

  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchSubredditPosts(subreddit, token);
      console.log(`r/${subreddit}: ${posts.length} posts`);

      for (const post of posts) {
        if (repliedSet.has(post.id)) continue;
        if (post.score < MIN_SCORE) continue;
        if (post.is_self === false && !post.selftext) continue; // link posts with no context

        const fullText = `${post.title} ${post.selftext || ''}`;
        if (!matchesTrigger(fullText)) continue;
        if (shouldSkip(fullText)) continue;
        if (!isQuestion(post)) continue;

        candidates.push({ subreddit, post });
      }

      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`r/${subreddit} failed: ${err.message}`);
    }
  }

  console.log(`\n${candidates.length} qualifying question posts found.`);

  if (candidates.length === 0) {
    console.log('Nothing to reply to this run.');
    return;
  }

  // Shuffle so we spread replies across subreddits randomly
  shuffle(candidates);
  const toReply = candidates.slice(0, MAX_REPLIES_PER_RUN);

  const replied = [];
  const failed = [];

  for (const { subreddit, post } of toReply) {
    console.log(`\nGenerating reply for r/${subreddit}: "${post.title.slice(0, 60)}..."`);

    let replyText;
    try {
      replyText = await generateReply(client, subreddit, post.title, post.selftext);
      if (!replyText) throw new Error('Claude returned empty reply');
    } catch (err) {
      console.error(`  Claude error: ${err.message}`);
      failed.push({ subreddit, post, reason: `Claude: ${err.message}` });
      continue;
    }

    console.log(`  Reply (${replyText.length} chars): ${replyText.slice(0, 80)}...`);

    try {
      await postComment(post.id, replyText, token);
      console.log(`  ✓ Posted to https://reddit.com${post.permalink}`);
      replied.push({ subreddit, post, replyText });
      state.repliedTo.push(post.id);
      saveState(state);
    } catch (err) {
      console.error(`  ✗ Post failed: ${err.message}`);
      failed.push({ subreddit, post, reason: err.message });
    }

    // Rate limit: 1 comment per 2 seconds
    await new Promise(r => setTimeout(r, 2000));
  }

  if (replied.length === 0 && failed.length === 0) return;

  // Build GitHub Issue summary
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const dateSlug = new Date().toISOString().slice(0, 10);

  const repliedSection = replied.length === 0
    ? '*None this run.*'
    : replied.map(({ subreddit, post, replyText }) =>
        `### r/${subreddit}\n**[${post.title}](https://reddit.com${post.permalink})**  \n↑ ${post.score} · ${post.num_comments} comments\n\n**Reply posted:**\n> ${replyText.replace(/\n/g, '\n> ')}`
      ).join('\n\n---\n\n');

  const failedSection = failed.length === 0
    ? ''
    : `\n\n---\n\n## ⚠️ Failed (${failed.length})\n\n` +
      failed.map(({ subreddit, post, reason }) =>
        `- r/${subreddit}: **${post.title.slice(0, 80)}** — *${reason}*`
      ).join('\n');

  const body = `## Reddit Replies — ${today}

Posted **${replied.length}** reply${replied.length !== 1 ? 'ies' : ''} automatically via Claude + Reddit API.

---

## ✅ Replies Posted (${replied.length})

${repliedSection}${failedSection}`;

  ghWithFile(`issue create --title "Reddit Replies — ${dateSlug}"`, body);
  console.log(`\nCreated GitHub Issue. Replied: ${replied.length}, Failed: ${failed.length}`);
}

main().catch(err => {
  console.error('Reddit reply bot failed:', err);
  process.exit(1);
});
