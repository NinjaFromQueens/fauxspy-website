/**
 * Faux Spy — Fetch Google Sheet Data
 * Downloads all tabs from the SEO spreadsheet and saves to scripts/data/sheet-data.json.
 * Called before generate-landing-pages.js.
 *
 * Usage: node scripts/fetch-sheet-data.js
 * Required env: GOOGLE_SHEETS_API_KEY
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const SHEET_ID = '1DLgMv1DesqActbt0eS-SODuTcQ6TBWLBUv5yyt7Qtdw';
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'sheet-data.json');

async function main() {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    console.error('❌ GOOGLE_SHEETS_API_KEY not set. Add it to .env.local');
    console.error('   Get a free key: console.cloud.google.com → APIs → Google Sheets API → Credentials');
    process.exit(1);
  }

  const sheets = google.sheets({ version: 'v4', auth: apiKey });

  console.log('📊 Fetching spreadsheet metadata...');
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabs = metadata.data.sheets.map(s => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
  console.log(`📋 Found ${tabs.length} tab(s): ${tabs.map(t => `"${t.title}"`).join(', ')}`);

  const result = {
    fetchedAt: new Date().toISOString(),
    sheetId: SHEET_ID,
    tabs: {},
  };

  for (const tab of tabs) {
    process.stdout.write(`  ⬇️  "${tab.title}"... `);
    let response;
    try {
      // Use explicit wide range to capture all columns (merged title row in A1 causes
      // auto-range detection to see only 1 column if we pass just the sheet name)
      response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${tab.title}'!A1:ZZ`,
        valueRenderOption: 'FORMATTED_VALUE',
      });
    } catch (err) {
      console.log(`SKIPPED (${err.message})`);
      continue;
    }

    const rows = response.data.values || [];
    if (rows.length < 2) {
      console.log('empty');
      result.tabs[tab.title] = { headers: [], rows: [] };
      continue;
    }

    // Find the real header row — skip merged title rows (rows with only 1 populated cell
    // that spans the whole sheet) and section header rows. The real header row is the
    // first row that has 2+ non-empty cells AND looks like column labels (short strings).
    let headerRowIdx = 0;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const row = rows[r] || [];
      const nonEmpty = row.filter(c => String(c).trim() !== '');
      if (nonEmpty.length >= 2) {
        // This row has multiple columns — likely the real header row
        headerRowIdx = r;
        break;
      }
    }

    const headers = (rows[headerRowIdx] || []).map(h => String(h).trim()).filter(Boolean);
    if (headers.length === 0) {
      console.log('no headers found');
      result.tabs[tab.title] = { headers: [], rows: [] };
      continue;
    }

    const data = rows.slice(headerRowIdx + 1)
      .filter(row => row && row.some(cell => String(cell).trim() !== ''))
      // Skip section header rows (rows where only first column has a value and it looks like a label)
      .filter(row => {
        const nonEmpty = (row || []).filter(c => String(c).trim() !== '');
        if (nonEmpty.length === 1) {
          const val = String(row[0] || '').trim();
          // Skip if it's a section header (ALL CAPS, or starts with SECTION, or is a single label word)
          if (/^SECTION /i.test(val) || /^[A-Z][A-Z\s&—–-]+$/.test(val)) return false;
        }
        return true;
      })
      .map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          if (h) obj[h] = String(row[i] || '').trim();
        });
        return obj;
      });

    result.tabs[tab.title] = { headers, rows: data, headerRowIdx };
    console.log(`${data.length} rows, ${headers.length} cols`);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

  console.log('\n✅ Saved to scripts/data/sheet-data.json');
  console.log('   Summary:');
  for (const [name, tab] of Object.entries(result.tabs)) {
    if (tab.rows.length > 0) {
      console.log(`   • "${name}": ${tab.rows.length} rows — headers: ${tab.headers.slice(0, 5).join(', ')}${tab.headers.length > 5 ? ', ...' : ''}`);
    }
  }
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
