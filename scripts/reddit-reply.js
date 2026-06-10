'use strict';

/**
 * Reddit AI Agent
 * Finds posts where people are asking about catfishing or fake profiles,
 * reads the subreddit's rules to ensure compliance, then generates a
 * human-sounding reply via Claude and posts it.
 *
 * Usage: node scripts/reddit-reply.js [--dry-run]
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
const MAX_REPLIES_PER_DAY = 5;
const MIN_SCORE = 2;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

const SUBREDDITS = [
  'catfish',
  'Scams',
  'onlinedating',
  'dating_advice',
  'relationships',
  'Tinder',
  'OnlineDating',
  'Bumble',
  'deepfakes',
];

const TRIGGER_PHRASES = [
  'catfish', 'catfishing', 'fake profile', 'fake photos', 'fake account',
  'fake pictures', 'reverse image search', 'deepfake', 'ai generated photo',
  'ai generated image', 'is this person real', 'how to tell if',
  'verify someone', 'fake dating profile', 'stolen photos',
  'too good to be true', 'suspicious profile', 'ai photo', 'detect ai',
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
    if (!s.daily_count) s.daily_count = 0;
    if (!s.daily_date) s.daily_date = '';
    return s;
  } catch {
    return { seenIds: [], repliedTo: [], lastChecked: null, daily_count: 0, daily_date: '' };
  }
}

function saveState(state) {
  if (state.repliedTo.length > 500) state.repliedTo = state.repliedTo.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function userAgent() {
  return `script:fauxspy-reply:v2.0 (by /u/${process.env.REDDIT_USERNAME})`;
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

async function getSubredditRules(token, subreddit) {
  try {
    const resp = await fetch(`https://oauth.reddit.com/r/${subreddit}/about/rules.json`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': userAgent(),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`  r/${subreddit}: could not fetch rules (HTTP ${resp.status})`);
      return null; // null = skip this subreddit entirely
    }

    const data = await resp.json();
    const rules = (data.rules || []);
    if (rules.length === 0) return 'No specific rules listed.';

    return rules
      .map((r, i) => `${i + 1}. ${r.short_name}${r.description ? ': ' + r.description.replace(/\n+/g, ' ').trim().slice(0, 200) : ''}`)
      .join('\n');
  } catch (err) {
    console.warn(`  r/${subreddit}: rules fetch failed — ${err.message}`);
    return null;
  }
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

async function generateReply(client, subreddit, title, selftext, rules) {
  const bodyPreview = (selftext || '').trim().slice(0, 500);
  const postContext = bodyPreview
    ? `Post title: "${title}"\n\nPost body: ${bodyPreview}`
    : `Post title: "${title}"`;

  const rulesSection = rules
    ? `Subreddit rules for r/${subreddit}:\n${rules}`
    : `No subreddit rules available.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    temperature: 0.8,
    system: `You are deciding whether and how to reply to a Reddit post as someone who uses Faux Spy (a Chrome extension that detects AI-generated images). Your reply must sound like a real person, not a company or bot.

${rulesSection}

COMPLIANCE CHECK (do this first):
- Would replying violate any rule above? Look for: self-promotion bans, link restrictions, no bot replies, spam rules.
- Can you add genuine value to this specific conversation — not just promote Faux Spy?
- If either fails, set shouldPost to false.

WRITING RULES when you do reply:
- Write like a real Reddit user. Use "I", "me", "honestly", "tbh", contractions, lowercase where natural.
- NEVER use bullet points, numbered lists, or headers — write in plain flowing sentences like people actually type.
- Vary the length: sometimes 1-2 sentences is enough. Not every reply needs to be a paragraph.
- Include one personal-sounding detail: "I ran into this last month", "happened to a friend on Bumble", "I've seen this on Tinder a few times"
- Match the subreddit's tone — casual subs get a casual reply
- Do NOT open with: "Great question", "As someone who", "I hope this helps", "That said", "In conclusion"
- Do NOT close with: "hope this helps", "feel free to ask", "let me know if you have questions"
- Mention Faux Spy ONLY if it directly solves the person's actual problem. Drop it naturally mid-sentence, not as a CTA. One sentence max — not a pitch.
- If you mention it: "I actually use this extension called faux spy (fauxspy.com) that checks photos" — casual and brief

BAD example (sounds like AI): "Great question! There are several ways to detect AI photos: 1) Check the background... 2) Look at fingers..."
GOOD example (sounds human): "the ears give it away most of the time honestly, AI still struggles with them. I started using a chrome extension called faux spy after I got burned twice, it scans the photo for you"

Respond ONLY with a JSON object — no other text, no markdown fences:
{"shouldPost": true/false, "replyText": "your reply here or empty string", "reason": "brief reason if not posting"}`,
    messages: [{ role: 'user', content: postContext }],
  });

  const raw = (message.content[0]?.type === 'text' ? message.content[0].text : '').trim();

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude response: ${raw.slice(0, 80)}`);

  return JSON.parse(jsonMatch[0]);
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
  if (DRY_RUN) console.log('🔍 DRY RUN — will not post anything\n');

  const missing = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD', 'ANTHROPIC_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`Reddit reply agent: missing env vars (${missing.join(', ')}) — skipping`);
    process.exit(0);
  }

  const state = loadState();

  // Reset daily counter on new UTC day
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date !== today) {
    state.daily_count = 0;
    state.daily_date = today;
  }

  if (state.daily_count >= MAX_REPLIES_PER_DAY && !DRY_RUN) {
    console.log(`Daily reply limit reached (${state.daily_count}/${MAX_REPLIES_PER_DAY}). Skipping this run.`);
    return;
  }

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

  // Collect qualifying question posts
  const candidates = [];
  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchSubredditPosts(subreddit, token);
      console.log(`r/${subreddit}: ${posts.length} posts`);

      for (const post of posts) {
        if (repliedSet.has(post.id)) continue;
        if (post.score < MIN_SCORE) continue;
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

  console.log(`\n${candidates.length} qualifying posts found.`);
  if (candidates.length === 0) return;

  shuffle(candidates);

  // Cap by remaining daily allowance
  const remaining = MAX_REPLIES_PER_DAY - state.daily_count;
  const toProcess = candidates.slice(0, Math.min(MAX_REPLIES_PER_RUN, remaining));

  const replied = [];
  const skipped = [];
  const failed = [];

  // Cache rules per subreddit — fetch once, reuse for multiple posts in same sub
  const rulesCache = {};

  for (const { subreddit, post } of toProcess) {
    console.log(`\nProcessing r/${subreddit}: "${post.title.slice(0, 70)}..."`);

    // Fetch and cache subreddit rules
    if (!(subreddit in rulesCache)) {
      console.log(`  Fetching rules for r/${subreddit}...`);
      rulesCache[subreddit] = DRY_RUN ? 'Dry run — rules not fetched.' : await getSubredditRules(token, subreddit);
      if (rulesCache[subreddit] === null) {
        console.log(`  Skipping all r/${subreddit} posts (rules unavailable — won't post blind)`);
      } else {
        console.log(`  Rules fetched.`);
      }
    }

    const rules = rulesCache[subreddit];
    if (rules === null) {
      skipped.push({ subreddit, post, reason: 'rules_unavailable' });
      continue;
    }

    let decision;
    try {
      decision = await generateReply(client, subreddit, post.title, post.selftext, rules);
    } catch (err) {
      console.error(`  Claude error: ${err.message}`);
      failed.push({ subreddit, post, reason: `Claude: ${err.message}` });
      continue;
    }

    if (!decision.shouldPost) {
      console.log(`  → Skipped: ${decision.reason || 'Claude decided not to post'}`);
      skipped.push({ subreddit, post, reason: decision.reason || 'claude_skip' });
      continue;
    }

    console.log(`  → Reply (${decision.replyText.length} chars): ${decision.replyText.slice(0, 90)}...`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would post to https://reddit.com${post.permalink}`);
      replied.push({ subreddit, post, replyText: decision.replyText });
      continue;
    }

    try {
      await postComment(post.id, decision.replyText, token);
      console.log(`  ✓ Posted to https://reddit.com${post.permalink}`);
      state.repliedTo.push(post.id);
      state.daily_count++;
      saveState(state);
      replied.push({ subreddit, post, replyText: decision.replyText });
    } catch (err) {
      if (err.message?.includes('RATELIMIT')) {
        console.error('  Reddit rate limit hit — stopping for this run.');
        break;
      }
      console.error(`  ✗ Post failed: ${err.message}`);
      failed.push({ subreddit, post, reason: err.message });
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nDone. Replied: ${replied.length}, Skipped: ${skipped.length}, Failed: ${failed.length}`);
  console.log(`Daily total: ${state.daily_count}/${MAX_REPLIES_PER_DAY}`);

  if (replied.length === 0 && failed.length === 0) return;

  // Build GitHub Issue summary
  const today2 = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const dateSlug = new Date().toISOString().slice(0, 10);

  const repliedSection = replied.length === 0
    ? '*None this run.*'
    : replied.map(({ subreddit, post, replyText }) =>
        `### r/${subreddit}\n**[${post.title}](https://reddit.com${post.permalink})**  \n↑ ${post.score} · ${post.num_comments} comments\n\n**Reply${DRY_RUN ? ' (DRY RUN)' : ''}:**\n> ${replyText.replace(/\n/g, '\n> ')}`
      ).join('\n\n---\n\n');

  const failedSection = failed.length === 0
    ? ''
    : `\n\n---\n\n## ⚠️ Failed (${failed.length})\n\n` +
      failed.map(({ subreddit, post, reason }) =>
        `- r/${subreddit}: **${post.title.slice(0, 80)}** — *${reason}*`
      ).join('\n');

  const body = `## Reddit Replies — ${today2}${DRY_RUN ? ' [DRY RUN]' : ''}

Posted **${replied.length}** repl${replied.length !== 1 ? 'ies' : 'y'} · Daily total: ${state.daily_count}/${MAX_REPLIES_PER_DAY}

---

## ✅ Replies Posted (${replied.length})

${repliedSection}${failedSection}`;

  ghWithFile(`issue create --title "Reddit Replies — ${dateSlug}${DRY_RUN ? ' [dry-run]' : ''}"`, body);
}

main().catch(err => {
  console.error('Reddit reply agent failed:', err);
  process.exit(1);
});
