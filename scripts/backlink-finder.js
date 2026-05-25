'use strict';

/**
 * Backlink Outreach Finder + Auto-Sender
 * Searches for sites writing about catfishing, fake profiles, and online dating safety.
 * Scrapes contact emails from each site and sends outreach via Resend automatically.
 * Falls back to contact form submission when no email is found.
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
const cheerio = require('cheerio');

const REPO = 'NinjaFromQueens/fauxspy-website';
const OUR_DOMAIN = 'fauxspy.com';
const STATE_FILE = path.join(__dirname, '..', 'outreach-state.json');
const MAX_EMAILS_PER_RUN = 8;
const FROM_EMAIL = 'Duron Epps <duron@fauxspy.com>';

// Queries that surface articles and guides our tool would genuinely help with
const SEARCH_QUERIES = [
  // Catfishing & fake profiles
  'catfish detector tool review',
  'how to spot fake dating profile photos',
  'reverse image search catfish guide',
  'online dating safety tips tools',
  'catfishing prevention resources',
  'how to tell if someone is real online dating',

  // Deepfakes
  'deepfake photo detection app',
  'how to detect deepfake images 2024',
  'deepfake detector tool review',
  'best deepfake detection software',

  // AI-generated image detection (broader)
  'how to tell if a photo is AI generated',
  'AI image detector free tool',
  'detect AI generated images browser extension',
  'is this photo real or AI generated',
  'AI photo verification guide',

  // Romance scams
  'romance scam warning signs tools',
  'how to avoid romance scams online',
  'online romance fraud prevention',

  // Media literacy / misinformation
  'how to spot fake photos online',
  'reverse image search guide detect fakes',
  'media literacy tools verify images',
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

      // Must look like a real email domain, not a file extension or versioned path
      if (!/\.[a-z]{2,}$/.test(domain)) continue;
      if (/\.(png|jpg|jpeg|gif|svg|webp|js|css|json|xml|zip|pdf|php|html|htm|ts|jsx|tsx|vue)$/i.test(domain)) continue;
      // Skip obvious placeholder/template addresses
      if (/^(you|user|name|email|example|test|placeholder|someone|nobody)@/i.test(email)) continue;
      // Domain must have at least one dot (e.g. not just "localhost")
      if (!domain.includes('.')) continue;

      return email;
    }

    // Small delay between page fetches
    await new Promise(r => setTimeout(r, 800));
  }

  return null;
}

function detectContactForm(html, baseUrl) {
  // Bail immediately if any CAPTCHA service is present — can't submit programmatically
  if (/g-recaptcha|h-captcha|cf-turnstile|grecaptcha|hcaptcha/i.test(html)) return null;

  const $ = cheerio.load(html);
  let found = null;

  $('form').each((_, formEl) => {
    if (found) return;
    const form = $(formEl);

    // Must have at least one textarea or text/email input (not a search box)
    const hasMessageField = form.find('textarea').length > 0 ||
      form.find('input[type="text"], input[type="email"], input:not([type])').length > 0;
    if (!hasMessageField) return;

    const fields = [];
    form.find('input, textarea, select').each((_, el) => {
      const $el = $(el);
      const tagName = (el.name || '').toLowerCase();
      const type = tagName === 'textarea' ? 'textarea' : ($el.attr('type') || 'text').toLowerCase();
      const name = $el.attr('name') || '';
      const value = $el.val() || $el.attr('value') || '';
      const style = ($el.attr('style') || '').toLowerCase();

      // Skip honeypot / invisible fields
      if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return;
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return;

      fields.push({ name, type, value: String(value) });
    });

    const rawAction = form.attr('action') || '';
    let action;
    try {
      action = rawAction ? new URL(rawAction, baseUrl).href : baseUrl;
    } catch {
      action = baseUrl;
    }

    const method = (form.attr('method') || 'POST').toUpperCase();
    if (method !== 'POST') return; // skip GET forms — can't send body

    found = {
      action,
      method,
      fields,
    };
  });

  return found;
}

async function submitContactForm(form, { name, email, subject, message }) {
  const NAME_RE = /^(your[_-]?)?((full[_-]?)?name|fname|first[_-]?name)$/i;
  const EMAIL_RE = /^(your[_-]?)?e?-?mail$/i;
  const SUBJECT_RE = /^(your[_-]?)?(subject|topic|title)$/i;
  const MESSAGE_RE = /^(your[_-]?)?(message|comments?|body|content|msg|text)$/i;

  const params = new URLSearchParams();
  for (const field of form.fields) {
    if (!field.name) continue;
    if (field.type === 'hidden') {
      params.set(field.name, field.value);
    } else if (NAME_RE.test(field.name)) {
      params.set(field.name, name);
    } else if (EMAIL_RE.test(field.name)) {
      params.set(field.name, email);
    } else if (SUBJECT_RE.test(field.name)) {
      params.set(field.name, subject);
    } else if (MESSAGE_RE.test(field.name) || field.type === 'textarea') {
      params.set(field.name, message);
    }
  }

  const resp = await fetch(form.action, {
    method: form.method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'fauxspy-outreach:v1.0 (contact: duroneppsjr7@gmail.com)',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });

  return { ok: resp.ok, status: resp.status };
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
  const formSubmissions = [];
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
      console.log(`    ✗ No contact email found — checking for contact form...`);

      // Try contact form fallback
      const origin = new URL(info.url).origin;
      let form = null;
      for (const contactUrl of [origin + '/contact', origin + '/contact-us']) {
        let html;
        try { html = await fetchPage(contactUrl); } catch { continue; }
        if (!html) continue;
        form = detectContactForm(html, contactUrl);
        if (form) { console.log(`    📋 Contact form found at ${contactUrl}`); break; }
      }

      if (form) {
        const formMessage = `Hi,

I came across your article and wanted to reach out. I built FauxSpy — a free Chrome extension that detects AI-generated images, helping people spot fake dating profiles and catfishing attempts in real time.

It might be worth a mention for your readers: https://fauxspy.com

Happy to answer any questions.

Duron Epps
FauxSpy — fauxspy.com`;

        try {
          const result = await submitContactForm(form, {
            name: 'Duron Epps',
            email: 'duron@fauxspy.com',
            subject: 'Quick mention for your readers — FauxSpy',
            message: formMessage,
          });
          if (result.ok || result.status < 400) {
            console.log(`    📝 Contact form submitted (HTTP ${result.status})`);
            formSubmissions.push({ domain, ...info });
            state.contacted[domain] = { date: today, method: 'form', sent: true };
            emailsSentThisRun++;
          } else {
            console.warn(`    ⚠️ Form submission failed: HTTP ${result.status}`);
            noEmail.push({ domain, ...info, reason: `Form submit failed (HTTP ${result.status})` });
          }
        } catch (err) {
          console.warn(`    ⚠️ Form submit error: ${err.message}`);
          noEmail.push({ domain, ...info, reason: `Form submit error: ${err.message}` });
        }
      } else {
        noEmail.push({ domain, ...info, reason: 'No email or contact form found' });
        // Don't persist — retry next week
      }

      saveOutreachState(state);
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }

    console.log(`    ✓ Found email: ${email}`);

    if (resend) {
      try {
        await sendOutreachEmail(resend, { to: email, title: info.title, domain });
        console.log(`    ✉️  Email sent to ${email}`);
        sent.push({ domain, email, ...info });
        state.contacted[domain] = { date: today, email, method: 'email', sent: true };
        emailsSentThisRun++;
      } catch (err) {
        console.error(`    ✗ Failed to send to ${email}: ${err.message}`);
        noEmail.push({ domain, ...info, reason: `Send failed: ${err.message}` });
        state.contacted[domain] = { date: today, email, method: 'email', sent: false };
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

  const formSection = formSubmissions.length === 0
    ? '*None.*'
    : formSubmissions.map(({ domain, url, title, query }) =>
        `### 📝 [${domain}](${url})\n**${title}**  \nFound via: *${query}*`
      ).join('\n\n---\n\n');

  const noEmailSection = noEmail.length === 0
    ? '*None.*'
    : noEmail.map(({ domain, url, title, reason }) =>
        `- [${domain}](${url}) — ${title}  \n  *${reason}*`
      ).join('\n');

  const alreadySection = alreadyContacted.length === 0
    ? '*None.*'
    : alreadyContacted.map(({ domain, url, date, email, method }) =>
        `- [${domain}](${url}) — contacted ${date}${method ? ` via ${method}` : ''}${email ? ` (${email})` : ''}`
      ).join('\n');

  const totalSent = sent.length + formSubmissions.length;
  const sendingNote = resend
    ? `Sent **${totalSent}** outreach${totalSent !== 1 ? 'es' : ''} (${sent.length} email, ${formSubmissions.length} contact form) automatically.`
    : `⚠️ Email sending disabled — RESEND_API_KEY not configured. Add it to GitHub Secrets to enable.`;

  const body = `## Backlink Outreach — ${displayDate}

${sendingNote}

---

## ✉️ Emails Sent (${sent.length})

${sentSection}

---

## 📝 Contact Forms Submitted (${formSubmissions.length})

These sites had no email but accepted a contact form submission.

${formSection}

---

## 🔍 No Contact Found (${noEmail.length})

These sites looked relevant but no contact method could be found. You can reach out manually if they're worth it.

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

  console.log(`\nDone. Emails: ${sent.length}, Forms: ${formSubmissions.length}, No contact: ${noEmail.length}, Already contacted: ${alreadyContacted.length}`);
}

main().catch(err => {
  console.error('Backlink finder failed:', err);
  process.exit(1);
});
