'use strict';

/**
 * Outreach Draft Finder
 * Finds articles and guides about catfishing, dating safety, scams and AI
 * images, has Claude check that each one is a genuine fit, and drafts a short
 * personal email for the ones that are. Posts the drafts as a weekly GitHub
 * Issue.
 *
 * Nothing is sent. This used to email every address it scraped (a skincare
 * brand, a racing-parts shop, the FTC...) and submit contact forms, from the
 * same domain that delivers license keys. Now a person reads the drafts and
 * sends the few worth sending.
 *
 * Usage: node scripts/backlink-finder.js
 * Required env: SERPAPI_KEY, ANTHROPIC_API_KEY, GH_TOKEN (auto-set in GitHub Actions)
 * Optional env: OUTREACH_MAILING_ADDRESS - postal address for the email footer
 *               (US anti-spam law requires one in commercial email)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk').default;

const REPO = 'NinjaFromQueens/fauxspy-website';
const STATE_FILE = path.join(__dirname, '..', 'outreach-state.json');
const QUERIES_PER_RUN = 10;      // rotates through SEARCH_QUERIES week by week
const MAX_SITES_TO_CHECK = 25;   // pages fetched and judged per run
const MAX_DRAFTS_PER_RUN = 10;
const REVIEW_AGAIN_AFTER_DAYS = 180;

// Queries that surface articles and guides our tool would genuinely help with
const SEARCH_QUERIES = [
  // Catfishing & fake profiles
  'catfish detector tool review',
  'how to spot fake dating profile photos',
  'reverse image search catfish guide',
  'online dating safety tips tools',
  'catfishing prevention resources',
  'how to tell if someone is real online dating',
  'fake profile picture detection guide',

  // Deepfakes
  'deepfake photo detection app review',
  'how to detect deepfake images guide',
  'deepfake detector tool review',
  'best deepfake detection software free',
  'deepfake romance scam how to protect yourself',
  'Chrome extension deepfake detector review',

  // AI-generated image detection (broader)
  'how to tell if a photo is AI generated',
  'best AI image detector tools comparison',
  'AI image detector free Chrome extension',
  'is this photo real or AI generated',
  'AI photo verification guide',
  'detect AI generated profile picture',
  'AI fake face detection tool review',

  // Dating safety + AI photos
  'fake AI profile picture dating app how to detect',
  'online dating safety AI generated photos',
  'dating app red flags AI fake photos',

  // Romance scam nonprofits + resources
  'romance scam victim support nonprofit resources',
  'romance scam warning signs tools',
  'military romance scam impersonation guide',
  'sweetheart scam prevention resources guide',
  'online romance fraud prevention',

  // Senior safety (highest-risk demographic)
  'senior online dating safety protect from scams',
  'protect seniors from romance scams online tools',

  // Cybersecurity awareness blogs
  'deepfake awareness cybersecurity training resources',
  'employee cybersecurity AI deepfake threats guide',

  // Journalism + fact-checking
  'journalist photo verification authenticity tools',
  'fact checking tools image verification guide',

  // Family / teen digital safety
  'protect kids teens AI fake photos social media',
  'family online safety AI scam awareness tools',
  'children digital literacy AI image safety',

  // Media literacy / misinformation
  'how to spot fake photos online guide',
  'media literacy tools verify images',
  'reverse image search guide detect fakes',
];

// Domains that are never useful outreach targets
const EXCLUDE_DOMAINS = new Set([
  'fauxspy.com',
  // Search engines & social platforms
  'google.com', 'google.co.uk', 'youtube.com', 'reddit.com', 'twitter.com', 'x.com',
  'facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'pinterest.com',
  // E-commerce / user-generated
  'amazon.com', 'etsy.com', 'yelp.com', 'quora.com',
  // Encyclopedias / wikis
  'wikipedia.org', 'wikihow.com',
  // App stores
  'apps.apple.com', 'play.google.com', 'chromewebstore.google.com',
  // Major news orgs (unreachable for cold outreach)
  'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'washingtonpost.com', 'theguardian.com',
  'forbes.com', 'businessinsider.com', 'techcrunch.com', 'wired.com', 'buzzfeed.com', 'huffpost.com',
  // Scripting / doc sites
  'medium.com', 'scribd.com', 'slideshare.net',
]);

// Government, military and research sites aren't places to pitch a product.
const GOVERNMENT_DOMAIN = /(^|\.)(gov|mil)(\.[a-z]{2})?$|(^|\.)gc\.ca$|(^|\.)nih\.gov$/i;

// Email prefixes that are generic/unmonitored
const SKIP_EMAIL_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'info', 'admin', 'support', 'help', 'webmaster',
  'privacy', 'legal', 'security', 'abuse', 'postmaster',
  'contact', 'hello', 'customercare', 'customerservice', 'sales', 'billing', 'careers', 'jobs',
];

// Template and example addresses that show up in page markup
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'test.com', 'email.com', 'domain.com',
  'yourdomain.com', 'yoursite.com', 'website.com', 'company.com', 'sentry.io',
]);
const OWN_EMAILS = new Set(['duroneppsjr7@gmail.com']);

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isExcludedDomain(domain) {
  if (!domain) return true;
  if (GOVERNMENT_DOMAIN.test(domain)) return true;
  if (EXCLUDE_DOMAINS.has(domain)) return true;
  for (const ex of EXCLUDE_DOMAINS) {
    if (domain.endsWith('.' + ex)) return true;
  }
  return false;
}

// A usable editorial contact: not generic, not a template, not ours, not government.
function isUsableEmail(email) {
  const [prefix, domain] = email.toLowerCase().split('@');
  if (!prefix || !domain || !domain.includes('.')) return false;
  if (OWN_EMAILS.has(email.toLowerCase()) || domain === 'fauxspy.com') return false;
  if (GOVERNMENT_DOMAIN.test(domain)) return false;
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain) || domain.endsWith('.sentry.io')) return false;
  if (SKIP_EMAIL_PREFIXES.some(p => prefix === p || prefix.startsWith(p + '.'))) return false;
  if (/^(you|your|user|name|email|example|test|placeholder|someone|nobody|john|jane)([._-]|$)/i.test(prefix)) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|js|css|json|xml|zip|pdf|php|html?)$/i.test(domain)) return false;
  if (prefix.length > 32 && /^[a-f0-9]+$/i.test(prefix)) return false; // tracking hashes
  return true;
}

function loadOutreachState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    s.contacted = s.contacted || {};
    s.reviewed = s.reviewed || {};
    return s;
  } catch {
    return { contacted: {}, reviewed: {} };
  }
}

function saveOutreachState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function recentlyReviewed(state, domain) {
  const r = state.reviewed[domain];
  return r && Date.now() - new Date(r.date).getTime() < REVIEW_AGAIN_AFTER_DAYS * 864e5;
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'fauxspy-outreach:v2.0 (contact: duroneppsjr7@gmail.com)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!resp.ok) return null;
  return resp.text();
}

function pageText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, header, form, svg').remove();
  const root = $('article').first().length ? $('article').first() : ($('main').first().length ? $('main').first() : $('body'));
  return root.text().replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function findEmails(html) {
  const emailRegex = /(?:mailto:)?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  return [...new Set([...html.matchAll(emailRegex)].map(m => m[1].toLowerCase()))].filter(isUsableEmail);
}

// The article itself, then the usual contact pages. Returns the first
// usable address and, failing that, a contact page the person can open.
async function findContact(articleUrl, articleHtml) {
  const fromArticle = findEmails(articleHtml)[0];
  if (fromArticle) return { email: fromArticle, contactPage: null };

  const origin = new URL(articleUrl).origin;
  let contactPage = null;
  for (const url of [origin + '/contact', origin + '/contact-us', origin + '/about']) {
    let html;
    try { html = await fetchPage(url); } catch { continue; }
    if (!html) continue;
    if (!contactPage && !url.endsWith('/about')) contactPage = url;
    const email = findEmails(html)[0];
    if (email) return { email, contactPage: null };
    await new Promise(r => setTimeout(r, 800));
  }
  return { email: null, contactPage };
}

async function searchSerpAPI(query) {
  const params = new URLSearchParams({
    q: query, api_key: process.env.SERPAPI_KEY, num: '10', hl: 'en', gl: 'us', safe: 'active',
  });
  const resp = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30000) });
  if (resp.status === 429) throw new Error('SerpAPI rate limit hit');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SerpAPI HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// A different slice of the query list each week, so every topic comes up
// without spending 40+ searches a run.
function queriesForThisRun(now = Date.now()) {
  const week = Math.floor(now / (7 * 864e5));
  const start = (week * QUERIES_PER_RUN) % SEARCH_QUERIES.length;
  return Array.from({ length: QUERIES_PER_RUN }, (_, i) => SEARCH_QUERIES[(start + i) % SEARCH_QUERIES.length]);
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    reason: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['relevant', 'reason', 'subject', 'body'],
  additionalProperties: false,
};

const DRAFT_SYSTEM = `You help the founder of Faux Spy decide which websites are worth one personal outreach email, and you draft that email.

About Faux Spy, so you describe it accurately: a free browser extension for Chrome, Firefox and Edge that checks whether an image on any website is AI-generated and shows a confidence score. Free for 3 checks a day with no account; Pro is $9.99 a month. Do not mention video detection (it isn't available right now), accuracy percentages, or anything not stated here.

A site is relevant only if the page is a guide, article or resource list about online dating safety, catfishing, romance scams or fraud prevention, AI-generated images or deepfakes, photo verification and media literacy, or family and senior online safety, and its readers would plausibly benefit from a tool that checks photos. Not relevant: businesses selling unrelated products or services, government agencies and law enforcement, academic papers, forums and Q&A threads, pages that use the word "image" in another sense, and competitors promoting their own detector. When unsure, mark it not relevant: a missed site costs nothing, an irrelevant email costs the sender's reputation.

If it is relevant, write the email to the page's author or editor:
- Mention one specific point from their page, using only what is in the page text you're given.
- Under 120 words, plain and friendly. No flattery, no hype, no "game-changer", no urgency.
- Say briefly what Faux Spy does and where it might fit for their readers (for example, alongside the tools or tips they already list).
- End with a low-pressure line such as offering to answer questions. Do not invent offers, discounts or statistics.
- Sign off exactly: "Duron, Faux Spy (fauxspy.com)". Do not add an unsubscribe line or address; those are appended separately.
- subject: short and specific to their page, no clickbait.

If it is not relevant, set relevant to false, give the reason in one sentence, and leave subject and body empty.`;

async function draftEmail(client, { domain, url, title, snippet, text }) {
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    system: DRAFT_SYSTEM,
    messages: [{
      role: 'user',
      content: `Site: ${domain}\nPage: ${url}\nTitle: ${title}\nSearch snippet: ${snippet}\n\nPage text (excerpt):\n${text}`,
    }],
  });
  if (response.stop_reason === 'refusal') return null;
  const block = response.content.find(b => b.type === 'text');
  return block ? JSON.parse(block.text) : null;
}

function emailFooter(address) {
  return `\n\n--\nIf you'd rather not hear from me, just reply "no thanks" and I won't email you again.\n${address || '[Add your mailing address here before sending]'}`;
}

function renderIssue({ drafts, skipped, address, displayDate, searchesFailed }) {
  const draftSections = drafts.length === 0
    ? '*No sites were a strong enough fit this week.*'
    : drafts.map((d, i) => {
        const to = d.email
          ? `**To:** \`${d.email}\` · [Open in your email app](mailto:${d.email}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)})`
          : `**No email found.** ${d.contactPage ? `Use their contact page: ${d.contactPage}` : 'Look for an author or editor link on the page.'}`;
        return `### ${i + 1}. [${d.domain}](${d.url})\n**${d.title}**  \n*Why it fits:* ${d.reason}  \n${to}\n\n**Subject:** ${d.subject}\n\n\`\`\`\n${d.body}\n\`\`\``;
      }).join('\n\n---\n\n');

  const skippedList = skipped.length === 0 ? '' : `\n\n<details><summary>Checked and skipped (${skipped.length})</summary>\n\n${
    skipped.map(s => `- [${s.domain}](${s.url}): ${s.reason}`).join('\n')}\n\n</details>`;

  return `## Outreach drafts — ${displayDate}

**Nothing was sent.** These are drafts for sites that look like a genuine fit. Pick the best few, check the details, edit them in your own voice, and send them yourself. A handful of personal emails a week does better than dozens of templated ones.
${address ? '' : '\n> ⚠️ Add your mailing address to each email before sending (US anti-spam law requires one), or set the `OUTREACH_MAILING_ADDRESS` repository variable so it fills in automatically. A PO box is fine.\n'}${searchesFailed ? `\n*${searchesFailed} search${searchesFailed === 1 ? '' : 'es'} failed this run.*\n` : ''}
---

${draftSections}${skippedList}

---

Close this issue when you're done with it.`;
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `outreach-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const missing = ['SERPAPI_KEY', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`Outreach drafts: ${missing.join(', ')} not set — skipping`);
    return;
  }

  const client = new Anthropic();
  const state = loadOutreachState();
  const today = new Date().toISOString().slice(0, 10);
  const address = (process.env.OUTREACH_MAILING_ADDRESS || '').trim();

  const queries = queriesForThisRun();
  console.log(`Running ${queries.length} searches via SerpAPI...\n`);

  const candidates = new Map(); // domain -> { url, title, snippet, query }
  let searchesFailed = 0;
  for (const query of queries) {
    try {
      const data = await searchSerpAPI(query);
      for (const result of data.organic_results || []) {
        const domain = getDomain(result.link);
        if (isExcludedDomain(domain) || candidates.has(domain)) continue;
        if (state.contacted[domain] || recentlyReviewed(state, domain)) continue;
        candidates.set(domain, {
          url: result.link,
          title: (result.title || '').replace(/\|/g, '–').trim(),
          snippet: (result.snippet || '').replace(/\n/g, ' ').trim().slice(0, 300),
          query,
        });
      }
      console.log(`"${query}": ${(data.organic_results || []).length} results`);
    } catch (err) {
      searchesFailed++;
      console.error(`Search failed for "${query}": ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n${candidates.size} new sites to check.\n`);

  const drafts = [];
  const skipped = [];
  let checked = 0;
  for (const [domain, info] of candidates) {
    if (checked >= MAX_SITES_TO_CHECK || drafts.length >= MAX_DRAFTS_PER_RUN) break;
    checked++;

    let html = null;
    try { html = await fetchPage(info.url); } catch { /* unreachable */ }
    if (!html) {
      skipped.push({ domain, url: info.url, reason: 'Page could not be loaded' });
      continue;
    }

    let decision;
    try {
      decision = await draftEmail(client, { domain, ...info, text: pageText(html) });
    } catch (err) {
      console.error(`  ${domain}: Claude error: ${err.message}`);
      skipped.push({ domain, url: info.url, reason: 'Could not be checked this run' });
      continue;
    }
    state.reviewed[domain] = { date: today, relevant: !!decision?.relevant };

    if (!decision?.relevant) {
      console.log(`  ${domain}: not a fit — ${decision?.reason || 'declined'}`);
      skipped.push({ domain, url: info.url, reason: decision?.reason || 'Not a fit' });
      continue;
    }

    const contact = await findContact(info.url, html);
    drafts.push({
      domain, url: info.url, title: info.title, reason: decision.reason,
      subject: decision.subject, body: decision.body + emailFooter(address), ...contact,
    });
    console.log(`  ${domain}: drafted${contact.email ? ` (to ${contact.email})` : ' (no email found)'}`);
  }

  saveOutreachState(state);

  const displayDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  ghWithFile(`issue create --title "Outreach drafts — ${today}"`, renderIssue({ drafts, skipped, address, displayDate, searchesFailed }));
  console.log(`\nDone. Drafts: ${drafts.length}, skipped: ${skipped.length}. Nothing was sent.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Outreach draft finder failed:', err);
    process.exit(1);
  });
}

module.exports = { isExcludedDomain, isUsableEmail, findEmails, queriesForThisRun, emailFooter, renderIssue, SEARCH_QUERIES };
