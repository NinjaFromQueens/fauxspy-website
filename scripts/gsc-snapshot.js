/**
 * Before/after Search Console numbers, for checking whether site changes
 * worked: daily totals for 120 days, and pages, queries and devices for the
 * last 14 days vs the 14 before.
 *
 * The output is encrypted: this repo is public, so anyone can download its
 * workflow artifacts, and search queries are private business data. Only
 * the holder of the private key matching SNAPSHOT_PUBLIC_KEY can read it.
 *
 * Usage: SNAPSHOT_PUBLIC_KEY=<base64 SPKI DER> node scripts/gsc-snapshot.js
 * Output: gsc-snapshot.enc.json
 * Required env: GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY (see seo-gsc.js)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SITE_URL, readCredentials, describeKey } = require('./seo-gsc');

const OUTPUT_FILE = path.join(__dirname, '..', 'gsc-snapshot.enc.json');

const fmt = d => d.toISOString().split('T')[0];
const daysAgo = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };

function encryptSnapshot(snapshot, publicKeyB64) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
  const key = crypto.publicEncrypt({
    key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
  }, aesKey);
  return {
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

async function main() {
  const publicKey = (process.env.SNAPSHOT_PUBLIC_KEY || '').trim();
  if (!publicKey) {
    console.error('❌ SNAPSHOT_PUBLIC_KEY is required: the snapshot is never written unencrypted.');
    process.exit(1);
  }
  const { email, key } = readCredentials();
  if (!email || !key) {
    console.error('❌ GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY are required.');
    process.exit(1);
  }
  const shape = describeKey(key);
  if (shape.header === 'missing' || shape.footer === 'missing') {
    console.error('❌ GSC_PRIVATE_KEY is not a usable private key:', JSON.stringify(shape));
    process.exit(1);
  }

  const { google } = require('googleapis');
  const auth = new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const query = async (range, dimensions, rowLimit = 1000) => {
    const res = await searchconsole.searchanalytics.query({ siteUrl: SITE_URL, requestBody: { ...range, dimensions, rowLimit } });
    return res.data.rows || [];
  };

  // Search Console's final numbers lag 2-3 days behind.
  const end = fmt(daysAgo(3));
  const recent = { startDate: fmt(daysAgo(16)), endDate: end };
  const before = { startDate: fmt(daysAgo(30)), endDate: fmt(daysAgo(17)) };

  const snapshot = {
    generatedAt: new Date().toISOString(),
    periods: { before, recent },
    daily: await query({ startDate: fmt(daysAgo(122)), endDate: end }, ['date'], 200),
    pages: { before: await query(before, ['page']), recent: await query(recent, ['page']) },
    queries: { before: await query(before, ['query']), recent: await query(recent, ['query']) },
    devices: { before: await query(before, ['device']), recent: await query(recent, ['device']) },
    pageQueries: await query(recent, ['page', 'query'], 5000),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(encryptSnapshot(snapshot, publicKey)));
  // Counts only: this workflow's logs are public too.
  console.log(`Saved ${path.basename(OUTPUT_FILE)} (encrypted): ${snapshot.daily.length} days, ` +
    `${snapshot.pages.recent.length} pages, ${snapshot.queries.recent.length} queries, ${snapshot.pageQueries.length} page/query rows`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('GSC snapshot failed:', err.message);
    process.exit(1);
  });
}

module.exports = { encryptSnapshot };
