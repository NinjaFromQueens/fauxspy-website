'use strict';

/**
 * Backlink Outreach Finder + Auto-Sender
 * Searches for sites writing about catfishing, fake profiles, and online dating safety.
 * Scrapes contact emails from each site and sends outreach via Resend automatically.
 * Posts a weekly GitHub Issue with a full summary of what was sent and what was skipped.
 *
 * Usage: node scripts/backlink-finder.js
 * Required env: SERPAPI_KEY, GH_TOKEN (auto-set in GitHub Actions)
 * Optional env: RESEND_API_KEY (if not set, emails are skipped but issue still posts)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Resend } = require('resend');

const REPO = 'NinjaFromQueens/fauxspy-website';
const OUR_DOMAIN = 'fauxspy.com';
const STATE_FILE = path.join(__dirname, '..', 'outreach-state.json');
const MAX_EMAILS_PER_RUN = 8;
const FROM_EMAIL = 'Duron Epps <duron@fauxspy.com>';

// Queries that surface articles and guides our tool would genuinely help with
const SEARCH_QUERIES = [
  'catfish detector tool review',
  'how to spot fake dating profile photos',
  'reverse image search catfish guide',
  'online dating safety tips tools',
  'deepfake photo detection app',
  'how to tell if instagram photos are fake',
  'best tools to check if someone is real online',
  'catfishing prevention resources',
];

// Domains that are never useful outreach targets
const EXCLUDE_DOMAINS = new Set([
  'fauxspy.com',
  'google.com', 'google.co.uk',
  'youtube.com',
  'reddit.com',
  'twitter.com', 'x.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'amazon.com',
  'wikipedia.org',
  'quora.com',
  'pinterest.com',
  'yelp.com',
  'bbc.com', 'bbc.co.uk',
  'cnn.com',
  'nytimes.com',
  'forbes.com',
]);

// Email prefixes that are generic/unmonitored — skip them
const SKIP_EMAIL_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'info', 'admin', 'support', 'help', 'webmaster',
  'privacy', 'legal', 'security', 'abuse', 'postmaster',
  'contact', 'hello', // too generic to be a real person
];

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isExcluded(domain) {
  if (!domain) return true;
  if (EXCLUDE_DOMAINS.has(domain)) return true;
  for (const ex of EXCLUDE_DOMAINS) {
    if (domain.endsWith('.' + ex)) return true;
  }
  return false;
}

function loadOutreachState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { contacted: {} };
  }
}

function saveOutreachState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'fauxspy-outreach:v1.0 (contact: duroneppsjr7@gmail.com)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!resp.ok) return null;
  return resp.text();
}

async function findContactEmail(articleUrl) {
  const origin = new URL(articleUrl).origin;
  const candidateUrls = [
    articleUrl,
    origin + '/contact',
    origin + '/contact-us',
    origin + '/about',
  ];

  // Matches email addresses in HTML (href="mailto:..." or plain text)
  const emailRegex = /(?:mailto:)?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;

  for (const url of candidateUrls) {
    let html;
    try {
      html = await fetchPage(url);
    } catch {
      continue;
    }
    if (!html) continue;

    const matches = [...html.matchAll(emailRegex)];
    for (const match of matches) {
      const email = match[1].toLowerCase();
      const prefix = email.split('@')[0];
      const domain = email.split('@')[1];

      // Skip our own domain and obviously generic addresses
      if (domain === OUR_DOMAIN) continue;
      if (SKIP_EMAIL_PREFIXES.some(p => prefix === p || prefix.startsWith(p + '.'))) continue;

      // Basic sanity check — must have a real TLD
      if (!/\.[a-z]{2,}$/.test(domain)) continue;

      return email;
    }

    // Small delay between page fetches
    await new Promise(r => setTimeout(r, 800));
  }

  return null;
}

async function sendOutreachEmail(resend, { to, title, domain }) {
  const text = `Hi there,

I came across your article "${title}" and wanted to reach out. I built FauxSpy — a free Chrome extension that detects AI-generated images and deepfakes, helping people spot fake dating profiles and catfishing attempts in real time. It's exactly the kind of tool your readers would find useful.

Would love it if you'd consider mentioning it: https://fauxspy.com or directly on the Chrome Web Store: https://chromewebstore.google.com/detail/faux-spy/npdkneknfigfcledlnmedkobcjdcigcg

Happy to answer any questions.

Thanks,
Duron Epps
Owner, FauxSpy`;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    reply_to: ['duroneppsjr7@gmail.com', 'duron@fauxspy.com'],
    subject: 'Quick mention for your readers — FauxSpy',
    text,
  });

  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

async function searchSerpAPI(query) {
  const params = new URLSearchParams({
    q: query,
    api_key: process.env.SERPAPI_KEY,
    num: '10',
    hl: 'en',
    gl: 'us',
    safe: 'active',
  });

  const resp = await fetch(`https://serpapi.com/search.json?${params}`, {
    signal: AbortSignal.timeout(20000),
  });

  if (resp.status === 429) throw new Error('SerpAPI rate limit hit');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SerpAPI HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `backlink-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  if (!process.env.SERPAPI_KEY) {
    console.log('SERPAPI_KEY not set — skipping backlink finder');
    process.exit(0);
  }

  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  if (!resend) {
    console.log('⚠️  RESEND_API_KEY not set — will find opportunities but skip email sending');
  }

  console.log(`Running ${SEARCH_QUERIES.length} searches via SerpAPI...\n`);

  const opportunities = new Map(); // domain -> { url, title, snippet, query }

  for (const query of SEARCH_QUERIES) {
    try {
      const data = await searchSerpAPI(query);
      const results = data.organic_results || [];
      console.log(`"${query}": ${results.length} results`);

      for (const result of results) {
        const domain = getDomain(result.link);
        if (isExcluded(domain)) continue;
        if (opportunities.has(domain)) continue;

        opportunities.set(domain, {
          url: result.link,
          title: (result.title || '').replace(/\|/g, '–').trim(),
          snippet: (result.snippet || '').replace(/\n/g, ' ').trim().slice(0, 180),
          query,
        });
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`Search failed for "${query}": ${err.message}`);
    }
  }

  if (opportunities.size === 0) {
    console.log('No outreach opportunities found this week.');
    return;
  }

  console.log(`\nFound ${opportunities.size} opportunities. Starting outreach...\n`);

  const state = loadOutreachState();
  const today = new Date().toISOString().slice(0, 10);

  const sent = [];
  const noEmail = [];
  const alreadyContacted = [];
  let emailsSentThisRun = 0;

  for (const [domain, info] of opportunities) {
    if (state.contacted[domain]) {
      alreadyContacted.push({ domain, ...info, ...state.contacted[domain] });
      continue;
    }

    if (emailsSentThisRun >= MAX_EMAILS_PER_RUN) {
      noEmail.push({ domain, ...info, reason: 'Run limit reached' });
      continue;
    }

    console.log(`  Searching for contact email on ${domain}...`);
    let email = null;
    try {
      email = await findContactEmail(info.url);
    } catch (err) {
      console.warn(`    ⚠️ Error scraping ${domain}: ${err.message}`);
    }

    if (!email) {
      console.log(`    ✗ No contact email found`);
      noEmail.push({ domain, ...info, reason: 'No email found' });
      // Don't persist to state — retry next week in case they add a contact page
      continue;
    }

    console.log(`    ✓ Found email: ${email}`);

    if (resend) {
      try {
        await sendOutreachEmail(resend, { to: email, title: info.title, domain });
        console.log(`    ✉️  Email sent to ${email}`);
        sent.push({ domain, email, ...info });
        state.contacted[domain] = { date: today, email, sent: true };
        emailsSentThisRun++;
      } catch (err) {
        console.error(`    ✗ Failed to send to ${email}: ${err.message}`);
        noEmail.push({ domain, ...info, reason: `Send failed: ${err.message}` });
        state.contacted[domain] = { date: today, email, sent: false };
      }
    } else {
      // Resend not configured — record the email we found but don't send
      noEmail.push({ domain, ...info, email, reason: 'RESEND_API_KEY not set' });
    }

    saveOutreachState(state);

    // Brief pause between sends
    if (emailsSentThisRun > 0) await new Promise(r => setTimeout(r, 1200));
  }

  // Build GitHub Issue body
  const displayDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const dateSlug = new Date().toISOString().slice(0, 10);

  const sentSection = sent.length === 0
    ? '*No emails sent this run.*'
    : sent.map(({ domain, email, url, title, query }) =>
        `### ✉️ [${domain}](${url})\n**${title}**  \nSent to: \`${email}\`  \nFound via: *${query}*`
      ).join('\n\n---\n\n');

  const noEmailSection = noEmail.length === 0
    ? '*None.*'
    : noEmail.map(({ domain, url, title, reason }) =>
        `- [${domain}](${url}) — ${title}  \n  *${reason}*`
      ).join('\n');

  const alreadySection = alreadyContacted.length === 0
    ? '*None.*'
    : alreadyContacted.map(({ domain, url, date, email }) =>
        `- [${domain}](${url}) — contacted ${date}${email ? ` (${email})` : ''}`
      ).join('\n');

  const sendingNote = resend
    ? `Sent **${sent.length}** email${sent.length !== 1 ? 's' : ''} automatically via Resend.`
    : `⚠️ Email sending disabled — RESEND_API_KEY not configured. Add it to GitHub Secrets to enable.`;

  const body = `## Backlink Outreach — ${displayDate}

${sendingNote}

---

## ✉️ Emails Sent (${sent.length})

${sentSection}

---

## 🔍 No Contact Found (${noEmail.length})

These sites looked relevant but no contact email could be scraped. You can reach out manually if they're worth it.

${noEmailSection}

---

## ⏭️ Already Contacted (${alreadyContacted.length})

${alreadySection}

---

Close this issue when reviewed.`;

  // Post or update the GitHub Issue
  const existing = JSON.parse(
    gh(`issue list --search "Backlink Outreach in:title" --state open --json number --limit 1`)
  );

  if (existing.length > 0) {
    ghWithFile(`issue comment ${existing[0].number}`, body);
    console.log(`\nUpdated existing backlink issue #${existing[0].number}.`);
  } else {
    ghWithFile(`issue create --title "Backlink Outreach — ${dateSlug}"`, body);
    console.log(`\nCreated backlink outreach issue.`);
  }

  console.log(`\nDone. Sent: ${sent.length}, No email: ${noEmail.length}, Already contacted: ${alreadyContacted.length}`);
}

main().catch(err => {
  console.error('Backlink finder failed:', err);
  process.exit(1);
});
