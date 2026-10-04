/**
 * One-off: correct misquoted McAfee statistics before they get source links.
 *
 * McAfee's February 2026 Valentine's research (7,000 adults surveyed) found
 * that 1 in 4 Americans have encountered a fake profile or AI bot, and 35%
 * have spotted AI-generated or modified photos on dating or social apps.
 * McAfee Labs separately found fake apps impersonating Plenty of Fish made up
 * 78% of the fake dating-app installs it detected (Dec 2025 – Jan 2026).
 *
 * Pages had drifted into claims the research doesn't make:
 *   - "1 in 4 online dating PROFILES are fake" (it's 1 in 4 people)
 *   - "1 in 4 Americans saw an AI photo on a dating app" (that figure is 35%,
 *     and covers dating OR social apps)
 *   - "55% of malicious Tinder clones use AI-generated images" (the 55% is
 *     Tinder's share of malicious detections, nothing to do with AI photos)
 *   - "7,000 U.S. adults" (the survey was multi-country)
 *
 * Usage: node scripts/geo/fix-mcafee-citations.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');

const PEOPLE = '1 in 4 Americans have encountered a fake profile or AI bot';
const PHOTOS = '35% have spotted AI-generated or modified photos on dating or social apps';

// [from, to] — exact strings, longest first.
const FIXES = [
  // Sentences that bundled both misquotes
  ['1 in 4 Americans (25%) encountered an AI-generated or AI-modified photo on a dating app in 2026 (McAfee). 35% of respondents specifically spotted an AI-generated photo while dating online. 55% of malicious clones on Tinder now use AI-generated images — meaning AI-generated photos are now more common than stolen real photos in scam profiles.',
    `${PEOPLE}, and ${PHOTOS} (McAfee, February 2026).`],
  ['1 in 4 Americans encountered an AI-generated or AI-modified photo on a dating app in 2026 (McAfee). 55% of malicious dating app clones now use AI-generated profile images.',
    `${PEOPLE}, and ${PHOTOS} (McAfee, February 2026).`],
  ['1 in 4 Americans encountered an AI-generated photo on a dating app in 2026 (McAfee). 55% of malicious clones on Tinder now use AI-generated images.',
    `${PEOPLE}, and ${PHOTOS} (McAfee, February 2026).`],

  // tinder.html
  ["McAfee research found that 55% of malicious clones now use AI-generated images, making it statistically more likely you'll encounter a synthetic profile than a real stolen photo on Tinder.",
    `McAfee's February 2026 research found ${PHOTOS} — and unlike a stolen photo, an AI-generated face has no original for reverse image search to find.`],
  ['According to McAfee research, 55% of malicious clones use AI-generated images.',
    `McAfee's February 2026 research found ${PHOTOS}.`],

  // online-dating-statistics.html
  ["1 in 4 online dating profiles is estimated to be fake or fraudulent, according to McAfee's 2026 Modern Love Report.",
    `${PEOPLE} online, according to McAfee's February 2026 research.`],
  ['<strong>1 in 4</strong> Americans encountered an AI-generated photo on a dating app in 2026 (McAfee Modern Love Report)',
    '<strong>1 in 4</strong> Americans have encountered a fake profile or AI bot (McAfee, February 2026)'],
  ['1 in 4 Americans encountered an AI-generated dating app photo in 2026.', `${PEOPLE} (McAfee, 2026).`],
  ['5.8M profiles removed for violations in H1 2024; 55% of malicious clones use AI photos', '5.8M profiles removed for violations in H1 2024'],
  ['1 in 4 profiles estimated fake; 71% of users say lying is common', '1 in 4 Americans have met a fake profile or AI bot; 71% of users say lying is common'],
  ['1 in 4 profiles is estimated to be fake.', `${PEOPLE}.`],
  ['1 in 4 profiles estimated fake.', '1 in 4 Americans have met a fake profile or AI bot.'],

  // what-is-catfishing.html
  ['1 in 4 online dating profiles is estimated to be fake (McAfee 2026).', `${PEOPLE} (McAfee 2026).`],

  // catfishing-statistics.html / deepfake-statistics.html lists
  ['<strong>1 in 4 Americans (25%)</strong> encountered an AI-generated or AI-modified photo on a dating app',
    '<strong>1 in 4 Americans</strong> have encountered a fake profile or AI bot online'],
  ['<strong>35%</strong> specifically spotted an AI-generated or AI-modified photo while using a dating app',
    '<strong>35%</strong> have spotted AI-generated or modified photos on dating or social apps'],
  ['<strong>78%</strong> of all fake dating app installations detected by McAfee originated from Plenty of Fish (POF) accounts',
    '<strong>78%</strong> of the fake dating-app installs McAfee Labs detected impersonated Plenty of Fish (Dec 2025 – Jan 2026)'],
  ['<strong>1 in 4 Americans</strong> — Encountered an AI-generated or AI-modified photo on a dating app in 2026 (McAfee)',
    '<strong>1 in 4 Americans</strong> — Have encountered a fake profile or AI bot (McAfee, February 2026)'],

  // fake-dating-profile-statistics.html
  ["1 in 4 Americans has encountered what they believe was a fake or AI-generated profile photo on a dating app.",
    '1 in 4 Americans have encountered a fake profile or AI bot.'],
  ['1 in 4 Americans has encountered a fake or AI-generated profile photo on a dating app.',
    '1 in 4 Americans have encountered a fake profile or AI bot.'],
  ['7,000 U.S. adults surveyed', '7,000 adults surveyed'],
  ['surveying 7,000 U.S. adults', 'surveying 7,000 adults'],
  ['1 in 4 encountered AI-generated photos (McAfee)', '35% spotted AI-generated photos (McAfee)'],

  // Meta / og descriptions
  ['1 in 4 Americans saw an AI-generated photo on a dating app.', '35% have spotted AI-generated photos on dating or social apps.'],
  ['1 in 4 Americans saw AI photos on dating apps', '35% spotted AI photos on dating or social apps'],

  // Stat-card labels sitting under a "1 in 4" figure
  ['Americans saw an AI-generated photo on a dating app', "Americans who've met a fake profile or AI bot"],
  ['Online dating profiles estimated to be fake (McAfee 2026)', "Americans who've met a fake profile or AI bot (McAfee 2026)"],
  ['Dating profiles estimated fake (McAfee 2023)', "Americans who've met a fake profile or AI bot (McAfee 2026)"],
  ['McAfee: dating profiles estimated to be fake', "McAfee 2026: Americans who've met a fake profile or AI bot"],
];

// Whole list items that only carried the 55% claim.
const DROP_LINES = [
  /^[ \t]*<li><strong>55%<\/strong> of malicious clones on Tinder now use AI-generated profile images<\/li>\r?\n/m,
  /^[ \t]*<li><strong>55% of malicious clones<\/strong> on Tinder now use AI-generated images \(McAfee 2026\)<\/li>\r?\n/m,
  /^[ \t]*<li><strong>55%<\/strong> of malicious clones on Tinder now use AI-generated images \(McAfee 2026\)[^<]*<\/li>\r?\n/m,
];

const hits = new Map(FIXES.map(([from]) => [from, 0]));
const touched = [];
for (const dir of ['pages', 'blog']) {
  for (const f of fs.readdirSync(path.join(SITE_ROOT, dir)).filter(f => f.endsWith('.html'))) {
    const file = path.join(SITE_ROOT, dir, f);
    let html = fs.readFileSync(file, 'utf8');
    const before = html;
    for (const [from, to] of FIXES) {
      const n = html.split(from).length - 1;
      if (n) { hits.set(from, hits.get(from) + n); html = html.split(from).join(to); }
    }
    for (const re of DROP_LINES) html = html.replace(re, '');
    if (html !== before) {
      touched.push(`${dir}/${f}`);
      if (!DRY_RUN) fs.writeFileSync(file, html, 'utf8');
    }
  }
}

console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}${touched.length} files: ${touched.join(', ')}`);
for (const [from, n] of hits) if (!n) console.log(`  unmatched: ${from.slice(0, 90)}`);
