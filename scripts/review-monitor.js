/**
 * Faux Spy CWS Review Monitor
 * Checks the Chrome Web Store listing for rating changes.
 * Opens a GitHub Issue when the rating drops or a review surge is detected.
 * Stores state in review-state.json (committed back by the workflow).
 *
 * Usage: node scripts/review-monitor.js
 * Required env: GH_TOKEN (auto-set in GitHub Actions)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXTENSION_ID = 'npdkneknfigfcledlnmedkobcjdcigcg';
const CWS_URL = `https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/${EXTENSION_ID}`;
const CWS_REVIEWS_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}/reviews`;
const STATE_FILE = path.join(__dirname, '..', 'review-state.json');
const REPO = 'NinjaFromQueens/fauxspy-website';

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `review-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { rating: null, reviewCount: null, lastChecked: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function fetchCWSData() {
  // Fetch the CWS listing page with a browser-like User-Agent
  const resp = await fetch(CWS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) throw new Error(`CWS returned HTTP ${resp.status}`);
  const html = await resp.text();

  // Try to extract aggregate rating from JSON-LD
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (jsonLdMatch) {
    for (const block of jsonLdMatch) {
      try {
        const json = JSON.parse(block.replace(/<\/?script[^>]*>/gi, ''));
        const rating = json.aggregateRating || json['aggregateRating'];
        if (rating) {
          return {
            rating: parseFloat(rating.ratingValue),
            reviewCount: parseInt(rating.reviewCount || rating.ratingCount || '0', 10),
          };
        }
      } catch {}
    }
  }

  // Fallback: look for rating patterns in the HTML
  const ratingMatch = html.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/);
  const countMatch = html.match(/"(?:reviewCount|ratingCount)"\s*:\s*"?(\d+)"?/);

  if (ratingMatch) {
    return {
      rating: parseFloat(ratingMatch[1]),
      reviewCount: countMatch ? parseInt(countMatch[1], 10) : null,
    };
  }

  // Second fallback: look for common HTML patterns
  const starMatch = html.match(/(\d+\.?\d*)\s*(?:out of 5|stars?)/i);
  if (starMatch) {
    return {
      rating: parseFloat(starMatch[1]),
      reviewCount: null,
    };
  }

  return { rating: null, reviewCount: null };
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const state = loadState();

  console.log('🌟 Checking Chrome Web Store rating...\n');
  console.log('  Previous state:', JSON.stringify(state));

  let current;
  try {
    current = await fetchCWSData();
    console.log('  Current data:', JSON.stringify(current));
  } catch (err) {
    console.error(`  Failed to fetch CWS data: ${err.message}`);
    // Don't alert on fetch failure — could be a network blip
    process.exit(0);
  }

  if (current.rating === null) {
    console.log('  Could not extract rating from CWS page — skipping.');
    process.exit(0);
  }

  const ratingDropped = state.rating !== null && current.rating < state.rating;
  // Alert if review count jumps by 5+ since last check (possible review storm)
  const reviewSurge = state.reviewCount !== null &&
    current.reviewCount !== null &&
    current.reviewCount - state.reviewCount >= 5;

  let alerted = false;

  if (ratingDropped) {
    const drop = (state.rating - current.rating).toFixed(2);
    const body = `## Rating dropped on Chrome Web Store

| | Before | Now |
|-|--------|-----|
| Rating | ${state.rating} ⭐ | **${current.rating} ⭐** |
| Review count | ${state.reviewCount ?? '?'} | ${current.reviewCount ?? '?'} |

The rating dropped by **${drop} stars** since the last check (${state.lastChecked}).

**[View reviews →](${CWS_REVIEWS_URL})**

Look for recent 1-2 star reviews — they usually call out a specific bug.`;

    ghWithFile(`issue create --title "⭐ CWS Rating Drop — ${current.rating} stars (was ${state.rating})"`, body);
    console.log(`\n⚠️  Alert: rating dropped from ${state.rating} to ${current.rating}`);
    alerted = true;
  }

  if (reviewSurge && !alerted) {
    const delta = current.reviewCount - state.reviewCount;
    const body = `## Unusual review activity on Chrome Web Store

| | Before | Now |
|-|--------|-----|
| Rating | ${state.rating} ⭐ | ${current.rating} ⭐ |
| Review count | ${state.reviewCount} | **${current.reviewCount}** |

**${delta} new reviews** were posted since the last check (${state.lastChecked}).

**[View reviews →](${CWS_REVIEWS_URL})**

Check if any new 1-2 star reviews are reporting a specific issue.`;

    ghWithFile(`issue create --title "⭐ CWS Review Surge — +${delta} reviews today"`, body);
    console.log(`\n⚠️  Alert: ${delta} new reviews detected`);
  }

  if (!ratingDropped && !reviewSurge) {
    console.log(`\n✅ No significant changes. Rating: ${current.rating} ⭐ (${current.reviewCount} reviews)`);
  }

  // Update stored state
  const newState = {
    rating: current.rating,
    reviewCount: current.reviewCount,
    lastChecked: new Date().toISOString(),
  };
  saveState(newState);
  console.log('\n  State updated:', JSON.stringify(newState));
}

main().catch(err => {
  console.error('Review monitor failed:', err.message);
  process.exit(1);
});
