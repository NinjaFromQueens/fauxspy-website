'use strict';

/**
 * Backlink Outreach Finder
 * Searches for sites writing about catfishing, fake profiles, and online dating safety
 * that could be a good fit for linking to fauxspy.com.
 * Posts a weekly GitHub Issue with the top opportunities.
 *
 * Usage: node scripts/backlink-finder.js
 * Required env: SERPAPI_KEY, GH_TOKEN (auto-set in GitHub Actions)
 * Free tier: 100 searches/month — this script uses ~8 per run (weekly = ~32/month)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO = 'NinjaFromQueens/fauxspy-website';
const OUR_DOMAIN = 'fauxspy.com';

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
  // Also exclude subdomains of excluded roots
  for (const ex of EXCLUDE_DOMAINS) {
    if (domain.endsWith('.' + ex)) return true;
  }
  return false;
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

  console.log(`Running ${SEARCH_QUERIES.length} searches via SerpAPI...\n`);

  // domain -> { url, title, snippet, query }
  const opportunities = new Map();

  for (const query of SEARCH_QUERIES) {
    try {
      const data = await searchSerpAPI(query);
      const results = data.organic_results || [];
      console.log(`"${query}": ${results.length} results`);

      for (const result of results) {
        const domain = getDomain(result.link);
        if (isExcluded(domain)) continue;
        if (opportunities.has(domain)) continue; // one entry per domain

        opportunities.set(domain, {
          url: result.link,
          title: (result.title || '').replace(/\|/g, '–').trim(),
          snippet: (result.snippet || '').replace(/\n/g, ' ').trim().slice(0, 180),
          query,
        });
      }

      // SerpAPI free tier — stay well under rate limits
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`Search failed for "${query}": ${err.message}`);
    }
  }

  if (opportunities.size === 0) {
    console.log('No outreach opportunities found this week.');
    return;
  }

  const entries = [...opportunities.entries()].slice(0, 25);
  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const rows = entries.map(([domain, { url, title, snippet, query }]) => {
    const snippetLine = snippet ? `\n  > ${snippet}` : '';
    const emailTemplate = `<details>
<summary>📧 Email template</summary>

**Subject:** Quick mention for your readers — FauxSpy

Hi there,

I came across your article "${title}" and wanted to reach out. I built FauxSpy — a free Chrome extension that detects AI-generated images and deepfakes, helping people spot fake dating profiles and catfishing attempts in real time. It's exactly the kind of tool your readers would find useful.

Would love it if you'd consider mentioning it: [fauxspy.com](https://fauxspy.com) or directly on the [Chrome Web Store](https://chromewebstore.google.com/detail/faux-spy/npdkneknfigfcledlnmedkobcjdcigcg).

Happy to answer any questions.

Thanks,
Duron Epps
Owner, FauxSpy

</details>`;
    return `### [${domain}](${url})\n**${title}**  \nFound via: *${query}*${snippetLine}\n\n${emailTemplate}`;
  }).join('\n\n---\n\n');

  const body = `## Backlink Outreach — ${today}

Found **${opportunities.size}** sites writing about catfishing, fake profile detection, or online dating safety. These are candidates to reach out to about linking to fauxspy.com.

**Before reaching out:** Visit each page and confirm they don't already link to fauxspy. Each entry has a ready-to-send email template — click "📧 Email template" to expand it.

---

${rows}

---

Close this issue when you've worked through the list.`;

  // Check for an open backlink issue from this week to avoid duplicates
  const dateSlug = new Date().toISOString().slice(0, 10);
  const existing = JSON.parse(
    gh(`issue list --search "Backlink Outreach in:title" --state open --json number --limit 1`)
  );

  if (existing.length > 0) {
    ghWithFile(`issue comment ${existing[0].number}`, body);
    console.log(`\nUpdated existing backlink issue #${existing[0].number} with ${opportunities.size} opportunities.`);
  } else {
    ghWithFile(`issue create --title "Backlink Outreach — ${dateSlug}"`, body);
    console.log(`\nCreated backlink outreach issue with ${opportunities.size} opportunities.`);
  }
}

main().catch(err => {
  console.error('Backlink finder failed:', err);
  process.exit(1);
});
