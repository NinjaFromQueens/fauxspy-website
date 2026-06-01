/**
 * Faux Spy — Fix Dataset Schema Errors
 * Fixes Google Search Console "Datasets structured data issues":
 *   - Adds missing "name" field to Dataset schema (CRITICAL)
 *   - Adds license, creator, distribution (non-critical recommendations)
 *   - Fixes invalid citation @type in investment-scam.html
 *
 * Idempotent: skips files that already have name in their Dataset block.
 * Usage: node scripts/fix-dataset-schema.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..');
const SITE_BASE = 'https://www.fauxspy.com';

const AFFECTED_FILES = [
  { path: 'blog/romance-scam-guide.html',    slug: 'blog/romance-scam-guide' },
  { path: 'blog/ai-influencer-fake.html',    slug: 'blog/ai-influencer-fake' },
  { path: 'blog/investment-scam.html',       slug: 'blog/investment-scam',    fixCitation: true },
  { path: 'blog/sextortion-scam.html',       slug: 'blog/sextortion-scam' },
  { path: 'blog/romance-scammer-photos.html', slug: 'blog/romance-scammer-photos' },
  { path: 'blog/romance-scam-stats.html',    slug: 'blog/romance-scam-stats' },
  { path: 'blog/pig-butchering-scam.html',   slug: 'blog/pig-butchering-scam' },
  { path: 'blog/military-romance-scam.html', slug: 'blog/military-romance-scam' },
  { path: 'blog/grandparent-scam.html',      slug: 'blog/grandparent-scam' },
  { path: 'blog/fake-job-scam.html',         slug: 'blog/fake-job-scam' },
  { path: 'blog/detect-deepfake-news.html',  slug: 'blog/detect-deepfake-news' },
  { path: 'blog/deepfake-scam.html',         slug: 'blog/deepfake-scam' },
  { path: 'blog/crypto-romance-scam.html',   slug: 'blog/crypto-romance-scam' },
  { path: 'blog/catfishing-statistics.html', slug: 'blog/catfishing-statistics' },
  { path: 'blog/ai-identity-theft.html',     slug: 'blog/ai-identity-theft' },
  { path: 'pages/romance-scam-statistics-2025.html', slug: 'romance-scam-statistics-2025' },
];

function fixDatasetSchema(html, slug, fixCitation) {
  // Find all <script type="application/ld+json"> blocks
  const scriptRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  let modified = false;

  const result = html.replace(scriptRegex, (fullMatch, jsonContent) => {
    let schema;
    try {
      schema = JSON.parse(jsonContent);
    } catch {
      return fullMatch; // skip unparseable blocks
    }

    // Check if this block contains a Dataset type
    const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
    if (!types.includes('Dataset')) return fullMatch;

    // Skip if name already present
    if (schema.name) {
      console.log(`  SKIP (name already set): ${slug}`);
      return fullMatch;
    }

    // Add name = headline (or description if no headline)
    schema.name = schema.headline || schema.description || slug.split('/').pop().replace(/-/g, ' ');

    // Add license
    if (!schema.license) {
      schema.license = 'https://creativecommons.org/licenses/by/4.0/';
    }

    // Add creator
    if (!schema.creator) {
      schema.creator = {
        '@type': 'Organization',
        'name': 'Faux Spy',
        'url': 'https://www.fauxspy.com'
      };
    }

    // Add distribution
    if (!schema.distribution) {
      schema.distribution = [{
        '@type': 'DataDownload',
        'encodingFormat': 'text/html',
        'contentUrl': `${SITE_BASE}/${slug}`
      }];
    }

    // Fix invalid citation type (investment-scam only)
    if (fixCitation && Array.isArray(schema.citation)) {
      schema.citation = schema.citation.map(c => {
        if (c['@type'] === 'Dataset') {
          return { ...c, '@type': 'CreativeWork' };
        }
        return c;
      });
    }

    modified = true;
    const fixedJson = JSON.stringify(schema, null, 2);
    return `<script type="application/ld+json">\n  ${fixedJson.replace(/\n/g, '\n  ')}\n  </script>`;
  });

  return { html: result, modified };
}

let fixed = 0, skipped = 0, errors = 0;

console.log('🔧 Fixing Dataset schema errors...\n');

for (const file of AFFECTED_FILES) {
  const filePath = path.join(SITE_ROOT, file.path);
  if (!fs.existsSync(filePath)) {
    console.log(`  MISSING: ${file.path}`);
    errors++;
    continue;
  }

  const html = fs.readFileSync(filePath, 'utf8');
  const { html: fixed_html, modified } = fixDatasetSchema(html, file.slug, file.fixCitation);

  if (!modified) {
    skipped++;
    continue;
  }

  fs.writeFileSync(filePath, fixed_html, 'utf8');
  console.log(`  ✅ Fixed: ${file.path}${file.fixCitation ? ' (+ citation type)' : ''}`);
  fixed++;
}

console.log(`\nDone: ${fixed} fixed, ${skipped} skipped, ${errors} errors`);
