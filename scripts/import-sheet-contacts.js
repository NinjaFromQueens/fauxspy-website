'use strict';

/**
 * Google Sheets → Resend Audience Importer
 * Downloads a publicly shared Google Sheet as CSV and adds each contact
 * to the Resend Audience. No Google auth required — sheet must be public.
 *
 * Usage: RESEND_API_KEY=xxx RESEND_AUDIENCE_ID=xxx node scripts/import-sheet-contacts.js
 * Optional: SHEET_ID=xxx (overrides the default sheet)
 *
 * Expected columns (0-indexed):
 *   0  Company Name
 *   1  Company Website
 *   2  Company Phone
 *   3  Company Address
 *   4  Company City
 *   5  Company State
 *   6  Contact First Name
 *   7  Contact Last Name
 *   8  Contact Title
 *   9  Contact Email   ← key field
 *   10 Contact LinkedIn URL
 */

const { Resend } = require('resend');

const DEFAULT_SHEET_ID = '1k1KqEMVNztsruhUM5WxxHul4XqKwLHnV9T62-owPLMI';
const SHEET_ID = process.env.SHEET_ID || DEFAULT_SHEET_ID;
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

const EMAIL_COL = 9;
const FIRST_NAME_COL = 6;
const LAST_NAME_COL = 7;

// ─── RFC 4180 CSV parser ──────────────────────────────────────────────────────
// Handles quoted fields that contain commas and newlines.

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
        i++;
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
        i += 2;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  if (field || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return rows;
}

// ─── Fetch CSV following redirects ───────────────────────────────────────────

async function fetchCSV(url, depth = 0) {
  if (depth > 3) throw new Error('Too many redirects');

  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'fauxspy-contact-importer/1.0' },
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching sheet`);
  return resp.text();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const missing = ['RESEND_API_KEY', 'RESEND_AUDIENCE_ID'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  console.log(`Fetching sheet: ${CSV_URL}\n`);
  const csv = await fetchCSV(CSV_URL);
  const rows = parseCSV(csv);

  console.log(`Total rows (including header): ${rows.length}`);

  // Skip row 0 (header)
  const dataRows = rows.slice(1);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of dataRows) {
    const email = (row[EMAIL_COL] || '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      skipped++;
      continue;
    }

    const firstName = (row[FIRST_NAME_COL] || '').trim() || undefined;
    const lastName = (row[LAST_NAME_COL] || '').trim() || undefined;

    process.stdout.write(`  Adding ${email}...`);

    try {
      const { error } = await resend.contacts.create({
        email,
        firstName,
        lastName,
        audienceId,
        unsubscribed: false,
      });

      if (error) {
        // Resend returns error for duplicates — treat as already added, not failure
        if (error.message && error.message.toLowerCase().includes('already')) {
          process.stdout.write(' already exists\n');
          skipped++;
        } else {
          process.stdout.write(` FAILED: ${error.message}\n`);
          failed++;
        }
      } else {
        process.stdout.write(' ✓\n');
        added++;
      }
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`);
      failed++;
    }

    // 300ms between calls — Resend rate limit safety
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Added:   ${added}`);
  console.log(`Skipped: ${skipped} (no email or already exists)`);
  console.log(`Failed:  ${failed}`);
  console.log(`─────────────────────────────`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
