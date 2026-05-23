/**
 * Faux Spy GSC Integration (F)
 * Fetches Search Console data for the past 90 days and writes gsc-data.json.
 *
 * Usage: node scripts/seo-gsc.js
 * Required env: GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SITE_URL = 'sc-domain:fauxspy.com';
const OUTPUT_FILE = path.join(__dirname, '..', 'gsc-data.json');
const DAYS = 90;

async function main() {
  const clientEmail = process.env.GSC_CLIENT_EMAIL;
  const privateKey = (process.env.GSC_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error('❌ GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY are required.');
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - DAYS);

  const fmt = d => d.toISOString().split('T')[0];

  console.log(`Fetching GSC data for ${SITE_URL} (${fmt(startDate)} → ${fmt(endDate)})...`);

  const response = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['page'],
      rowLimit: 500,
    },
  });

  const rows = response.data.rows || [];
  console.log(`  ${rows.length} pages returned from Search Console`);

  const pages = rows.map(row => ({
    url: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: parseFloat((row.ctr * 100).toFixed(2)),
    position: parseFloat(row.position.toFixed(1)),
  }));

  // Flag pages with high impressions but low CTR (potential title/desc improvements)
  const LOW_CTR_THRESHOLD = 3.0;
  const HIGH_IMPRESSIONS_MIN = 100;
  const lowCtrPages = pages.filter(
    p => p.impressions >= HIGH_IMPRESSIONS_MIN && p.ctr < LOW_CTR_THRESHOLD
  );

  const output = {
    generatedAt: new Date().toISOString(),
    period: { startDate: fmt(startDate), endDate: fmt(endDate) },
    pages,
    lowCtrPages,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`  Saved to gsc-data.json (${pages.length} pages, ${lowCtrPages.length} low-CTR pages flagged)`);
}

main().catch(err => {
  console.error('GSC fetch failed:', err.message);
  process.exit(1);
});
