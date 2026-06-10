'use strict';

/**
 * Reddit/Forum Monitor
 * Scans public subreddits for posts about catfishing, fake profiles, and deepfake detection.
 * Surfaces opportunities for authentic engagement. Never auto-posts.
 *
 * Usage: node scripts/reddit-monitor.js
 * Required env: GH_TOKEN (auto-set in GitHub Actions)
 * State file: reddit-state.json (committed back by workflow)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const STATE_FILE = path.join(__dirname, '..', 'reddit-state.json');
const REPO = 'NinjaFromQueens/fauxspy-website';

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

// Phrases that signal someone needs help detecting fake profiles
const TRIGGER_PHRASES = [
  'catfish',
  'catfishing',
  'fake profile',
  'fake photos',
  'fake account',
  'fake pictures',
  'reverse image search',
  'deepfake',
  'ai generated photo',
  'ai generated image',
  'is this person real',
  'how to tell if',
  'verify someone',
  'fake dating profile',
  'stolen photos',
  'too good to be true',
  'suspicious profile',
  'ai photo',
  'detect ai',
  'is this ai',
  'real photo',
];

// Skip posts that already mention fauxspy or our competitors by name
const SKIP_IF_CONTAINS = ['fauxspy', 'faux spy'];

// Minimum upvotes OR comments for a post to be worth surfacing
const MIN_ENGAGEMENT = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seenIds: [], lastChecked: null };
  }
}

function saveState(state) {
  // Cap stored IDs at 1000 to prevent unbounded growth
  if (state.seenIds.length > 1000) {
    state.seenIds = state.seenIds.slice(-1000);
  }
  state.lastChecked = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function matchesTrigger(text) {
  const lower = (text || '').toLowerCase();
  return TRIGGER_PHRASES.some(p => lower.includes(p));
}

function shouldSkip(text) {
  const lower = (text || '').toLowerCase();
  return SKIP_IF_CONTAINS.some(p => lower.includes(p));
}

async function fetchSubreddit(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=25&t=day`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'fauxspy-monitor:v1.0 (contact: duroneppsjr7@gmail.com)',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (resp.status === 429) {
    console.warn(`r/${subreddit}: rate limited, skipping`);
    return [];
  }
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status} for r/${subreddit}`);
  const data = await resp.json();
  return (data.data?.children || []).map(c => c.data);
}

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `reddit-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const state = loadState();
  const seenSet = new Set(state.seenIds);
  const matches = [];

  console.log(`Scanning ${SUBREDDITS.length} subreddits for catfish/fake profile mentions...\n`);

  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchSubreddit(subreddit);
      console.log(`r/${subreddit}: ${posts.length} posts fetched`);

      for (const post of posts) {
        if (seenSet.has(post.id)) continue;
        seenSet.add(post.id);

        const fullText = `${post.title} ${post.selftext || ''}`;

        if (!matchesTrigger(fullText)) continue;
        if (shouldSkip(fullText)) continue;
        if (post.score < MIN_ENGAGEMENT && post.num_comments < MIN_ENGAGEMENT) continue;

        // Prefer posts where someone is asking a question or seeking help
        const isQuestion = post.title.includes('?') ||
          /\b(how|what|can i|is there|anyone|help|advice|should i)\b/i.test(post.title);

        matches.push({
          id: post.id,
          subreddit,
          title: post.title,
          url: `https://reddit.com${post.permalink}`,
          score: post.score,
          comments: post.num_comments,
          isQuestion,
          preview: (post.selftext || '').replace(/\n+/g, ' ').trim().slice(0, 220),
          created: new Date(post.created_utc * 1000).toISOString(),
        });
      }

      // Respect Reddit's rate limit — 1 request per second recommended
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`r/${subreddit} failed: ${err.message}`);
    }
  }

  // Persist seen IDs so we don't repeat on the next run
  state.seenIds = [...seenSet];
  saveState(state);

  if (matches.length === 0) {
    console.log('No new relevant posts — nothing to report.');
    return;
  }

  // Sort: questions first, then by engagement
  matches.sort((a, b) => {
    if (a.isQuestion && !b.isQuestion) return -1;
    if (!a.isQuestion && b.isQuestion) return 1;
    return (b.score + b.comments) - (a.score + a.comments);
  });

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const postBlocks = matches.map(m => {
    const label = m.isQuestion ? '❓ Question' : '💬 Discussion';
    const previewLine = m.preview ? `\n> ${m.preview}${m.preview.length >= 220 ? '…' : ''}` : '';
    return `### ${label} — r/${m.subreddit}\n**[${m.title}](${m.url})**  \n↑ ${m.score} · ${m.comments} comments${previewLine}`;
  }).join('\n\n---\n\n');

  const body = `## Reddit Mentions — ${today}

Found **${matches.length}** new post${matches.length === 1 ? '' : 's'} about catfishing or fake profile detection across ${SUBREDDITS.length} subreddits.

Questions are listed first — those are the best chances to help someone and mention fauxspy naturally.

---

${postBlocks}

---

**How to engage:** Read the post, give a genuine answer to their actual question, and only mention fauxspy if it directly solves their problem. Don't paste the same reply on multiple posts.`;

  const dateSlug = new Date().toISOString().slice(0, 10);
  ghWithFile(
    `issue create --title "Reddit Mentions — ${dateSlug}"`,
    body
  );

  console.log(`\nCreated GitHub Issue with ${matches.length} Reddit posts.`);
}

main().catch(err => {
  console.error('Reddit monitor failed:', err);
  process.exit(1);
});
