'use strict';

/**
 * Reddit Reply Drafts
 * Finds recent posts where people ask about catfishing, fake profiles or AI
 * photos, reads each subreddit's rules, and has Claude draft a genuinely
 * helpful reply. The drafts go to a GitHub Issue; you post the good ones
 * yourself.
 *
 * Nothing is posted. Replies that mention Faux Spy say you make it: Reddit
 * bans accounts (and can block a domain site-wide) for undisclosed
 * self-promotion, and US endorsement rules require the disclosure too.
 *
 * Reading uses Reddit's app-only OAuth (client id + secret, no account
 * login), which can't post at all. Reddit refuses anonymous requests from
 * GitHub's servers, so the credentials are needed even just to read.
 *
 * Usage: node scripts/reddit-reply.js
 * Required env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, ANTHROPIC_API_KEY,
 *               GH_TOKEN (auto-set in GitHub Actions)
 * State file: reddit-state.json (shared with reddit-monitor.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk').default;

const STATE_FILE = path.join(__dirname, '..', 'reddit-state.json');
const REPO = 'NinjaFromQueens/fauxspy-website';
const MAX_DRAFTS_PER_RUN = 5;
const MIN_SCORE = 2;
const USER_AGENT = 'script:fauxspy-reply-drafts:v3.0 (contact: duroneppsjr7@gmail.com)';

const SUBREDDITS = [
  'catfish', 'Scams', 'onlinedating', 'dating_advice', 'relationships',
  'Tinder', 'OnlineDating', 'Bumble', 'deepfakes',
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

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    s.draftedFor = s.draftedFor || [];
    return s;
  } catch {
    return { seenIds: [], draftedFor: [], lastChecked: null };
  }
}

function saveState(state) {
  if (state.draftedFor.length > 500) state.draftedFor = state.draftedFor.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// App-only token: read access to public content, no posting.
async function getRedditToken() {
  const creds = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`Reddit auth failed: HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Reddit auth error: ${data.error}`);
  return data.access_token;
}

async function redditGet(token, pathAndQuery) {
  const resp = await fetch(`https://oauth.reddit.com${pathAndQuery}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(12000),
  });
  if (resp.status === 429) return null;
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status} for ${pathAndQuery}`);
  return resp.json();
}

async function getSubredditRules(token, subreddit) {
  try {
    const data = await redditGet(token, `/r/${subreddit}/about/rules.json`);
    if (!data) return null;
    const rules = data.rules || [];
    if (rules.length === 0) return 'No specific rules listed.';
    return rules
      .map((r, i) => `${i + 1}. ${r.short_name}${r.description ? ': ' + r.description.replace(/\n+/g, ' ').trim().slice(0, 300) : ''}`)
      .join('\n');
  } catch (err) {
    console.warn(`  r/${subreddit}: rules fetch failed — ${err.message}`);
    return null;
  }
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    worthReplying: { type: 'boolean' },
    reason: { type: 'string' },
    mentionsFauxSpy: { type: 'boolean' },
    replyText: { type: 'string' },
  },
  required: ['worthReplying', 'reason', 'mentionsFauxSpy', 'replyText'],
  additionalProperties: false,
};

const REPLY_SYSTEM = `You draft Reddit replies for the maker of Faux Spy, a free browser extension (Chrome, Firefox, Edge) that checks whether an image is AI-generated and shows a confidence score; 3 free checks a day, no account. A person will read your draft, edit it, and decide whether to post it under their own account.

The reply must help the person who posted, on its own merits, even if they never click anything: practical, specific advice for their situation (for example, what to look for in the photos, asking for a quick video call, why reverse image search misses AI-generated faces, how to report the profile, not sending money).

Honesty rules, no exceptions:
- Never pretend to be a customer or a neutral bystander, and never invent personal experiences ("this happened to me", "a friend got burned").
- Mention Faux Spy only if checking photos would directly help this person AND the subreddit rules allow it. When you mention it, disclose in the same sentence that the poster makes it, e.g. "(Disclosure: I make this) Faux Spy, a free extension, can check whether a photo is AI-generated." One sentence, no link unless the rules allow links, then back to helping.
- If the rules ban self-promotion or links, either help without mentioning Faux Spy or say it isn't worth replying.
- Make no claims beyond the description above (no accuracy numbers, no video detection).

Style: plain sentences like a thoughtful person typing on Reddit; match the subreddit's tone; a few sentences is usually enough; no opener like "Great question", no sign-off like "Hope this helps".

Set worthReplying to false when you can't add real value, the post isn't really asking for help, or replying would break a rule; give the reason in one sentence and leave replyText empty.`;

async function draftReply(client, { subreddit, post, rules }) {
  const body = (post.selftext || '').trim().slice(0, 1500);
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    system: REPLY_SYSTEM,
    messages: [{
      role: 'user',
      content: `Subreddit: r/${subreddit}\nRules:\n${rules}\n\nPost title: ${post.title}\n\nPost body:\n${body || '(no body)'}`,
    }],
  });
  if (response.stop_reason === 'refusal') return null;
  const block = response.content.find(b => b.type === 'text');
  return block ? JSON.parse(block.text) : null;
}

function renderDrafts(drafts) {
  return drafts.map(({ subreddit, post, decision }) =>
    `### r/${subreddit}: [${post.title}](https://www.reddit.com${post.permalink})\n↑ ${post.score} · ${post.num_comments} comments${decision.mentionsFauxSpy ? ' · mentions Faux Spy (disclosed)' : ''}\n\n\`\`\`\n${decision.replyText}\n\`\`\``
  ).join('\n\n---\n\n');
}

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `reddit-drafts-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const missing = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`Reddit reply drafts: ${missing.join(', ')} not set — skipping`);
    return;
  }

  const state = loadState();
  const drafted = new Set(state.draftedFor);
  const client = new Anthropic();
  const token = await getRedditToken();

  const candidates = [];
  for (const subreddit of SUBREDDITS) {
    try {
      const data = await redditGet(token, `/r/${subreddit}/new?limit=25`);
      const posts = (data?.data?.children || []).map(c => c.data);
      for (const post of posts) {
        if (drafted.has(post.id) || post.score < MIN_SCORE || post.locked || post.archived) continue;
        const fullText = `${post.title} ${post.selftext || ''}`;
        if (!matchesTrigger(fullText) || shouldSkip(fullText) || !isQuestion(post)) continue;
        candidates.push({ subreddit, post });
      }
      console.log(`r/${subreddit}: ${posts.length} posts`);
    } catch (err) {
      console.error(`r/${subreddit} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\n${candidates.length} candidate posts.`);
  candidates.sort((a, b) => b.post.score - a.post.score);

  const rulesCache = {};
  const drafts = [];
  for (const { subreddit, post } of candidates) {
    if (drafts.length >= MAX_DRAFTS_PER_RUN) break;
    if (!(subreddit in rulesCache)) rulesCache[subreddit] = await getSubredditRules(token, subreddit);
    if (rulesCache[subreddit] === null) continue; // never draft blind to a sub's rules

    let decision;
    try {
      decision = await draftReply(client, { subreddit, post, rules: rulesCache[subreddit] });
    } catch (err) {
      console.error(`  Claude error: ${err.message}`);
      continue;
    }
    state.draftedFor.push(post.id);
    if (!decision?.worthReplying || !decision.replyText) {
      console.log(`  r/${subreddit} "${post.title.slice(0, 60)}": skipped — ${decision?.reason || 'declined'}`);
      continue;
    }
    drafts.push({ subreddit, post, decision });
    console.log(`  r/${subreddit} "${post.title.slice(0, 60)}": drafted`);
  }

  saveState(state);
  if (drafts.length === 0) return;

  // One issue per day; later runs add to it.
  const today = new Date().toISOString().slice(0, 10);
  const title = `Reddit reply drafts — ${today}`;
  const header = '**Nothing was posted.** Read each draft, edit it in your own words, and post the ones that genuinely help. Check the thread first: it may already be answered.\n\n---\n\n';
  const existing = JSON.parse(gh(`issue list --search "\\"${title}\\" in:title" --state open --json number --limit 1`));
  if (existing.length > 0) {
    ghWithFile(`issue comment ${existing[0].number}`, renderDrafts(drafts));
  } else {
    ghWithFile(`issue create --title "${title}"`, header + renderDrafts(drafts));
  }
  console.log(`\nDone. ${drafts.length} drafts. Nothing was posted.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Reddit reply drafts failed:', err);
    process.exit(1);
  });
}

module.exports = { matchesTrigger, shouldSkip, isQuestion, renderDrafts };
