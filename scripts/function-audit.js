/**
 * Faux Spy Function Auditor
 * Tests every critical app function end-to-end against the live site.
 * Opens a GitHub Issue if any check fails; auto-closes when recovered.
 *
 * Usage: node scripts/function-audit.js
 * Required env: GH_TOKEN (auto-set in GitHub Actions)
 * Optional env: SITE_URL (defaults to https://fauxspy.com)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SITE = process.env.SITE_URL || 'https://www.fauxspy.com';
const REPO = 'NinjaFromQueens/fauxspy-website';
const ALERT_TITLE = '🚨 Function Audit Failed';

// ─── GitHub helpers (same pattern as health-monitor.js) ──────────────────────

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `audit-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ─── Check runner ─────────────────────────────────────────────────────────────

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    return { name, pass: true };
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    return { name, pass: false, error: err.message };
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Accept-Encoding': 'identity', // prevent undici/Vercel compression mismatch
  'User-Agent': 'FauxSpy-FunctionAudit/1.0',
};

async function fetchJSON(url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(20000),
    headers: { ...BASE_HEADERS, ...(opts.headers || {}) },
  });
  let body;
  try { body = await resp.json(); } catch { body = null; }
  return { status: resp.status, body };
}

async function fetchRaw(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'FauxSpy-FunctionAudit/1.0' },
  });
  return { status: resp.status, contentType: resp.headers.get('content-type') || '' };
}

// ─── Audit checks ─────────────────────────────────────────────────────────────

async function runChecks() {
  console.log(`\n🔍 Running function audit against ${SITE}\n`);
  const results = [];

  // 1. Homepage
  results.push(await check('Homepage loads', async () => {
    const { status } = await fetchRaw(`${SITE}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
  }));

  // 2. OG image
  results.push(await check('og-image.png exists', async () => {
    const { status, contentType } = await fetchRaw(`${SITE}/og-image.png`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (!contentType.includes('image')) throw new Error(`Wrong content-type: ${contentType}`);
  }));

  // 3. Health endpoint (401 = reachable but no token; 200 = full check)
  results.push(await check('Health endpoint reachable', async () => {
    const adminToken = process.env.ADMIN_TOKEN;
    const url = adminToken ? `${SITE}/api/health?token=${adminToken}` : `${SITE}/api/health`;
    const { status } = await fetchRaw(url);
    if (status !== 200 && status !== 401) throw new Error(`HTTP ${status}`);
  }));

  // 4. Checkout — invalid plan should return 400
  results.push(await check('Checkout rejects invalid plan', async () => {
    const { status, body } = await fetchJSON(`${SITE}/api/create-checkout`, {
      method: 'POST',
      body: JSON.stringify({ plan: 'notaplan' }),
    });
    if (status !== 400) throw new Error(`Expected 400, got ${status}. Body: ${JSON.stringify(body)}`);
    if (body?.error !== 'INVALID_PLAN') throw new Error(`Expected INVALID_PLAN error, got: ${body?.error}`);
  }));

  // 5. Checkout — no body should return 400 or 500, never 200
  results.push(await check('Checkout rejects empty body', async () => {
    const { status } = await fetchJSON(`${SITE}/api/create-checkout`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (status === 200) throw new Error('Empty body returned 200 — should be 400/500');
  }));

  // 6. License validation — bad format should return 400
  results.push(await check('License validation rejects bad format', async () => {
    const { status, body } = await fetchJSON(`${SITE}/api/validate-license`, {
      method: 'POST',
      body: JSON.stringify({ licenseKey: 'not-a-real-key' }),
    });
    if (status !== 400) throw new Error(`Expected 400, got ${status}`);
    if (body?.valid !== false) throw new Error(`Expected valid:false, got: ${body?.valid}`);
  }));

  // 7. License validation — well-formatted but nonexistent key should return 404
  results.push(await check('License validation returns 404 for unknown key', async () => {
    const { status, body } = await fetchJSON(`${SITE}/api/validate-license`, {
      method: 'POST',
      body: JSON.stringify({ licenseKey: 'FAUX-0000-0000-0000-0000' }),
    });
    if (status !== 404) throw new Error(`Expected 404, got ${status}`);
    if (body?.valid !== false) throw new Error(`Expected valid:false`);
  }));

  // 8. Billing portal — unknown email should return 404
  results.push(await check('Billing portal returns 404 for unknown email', async () => {
    const { status } = await fetchJSON(`${SITE}/api/billing-portal`, {
      method: 'POST',
      body: JSON.stringify({ email: 'audit-check-notreal@fauxspy.com' }),
    });
    if (status !== 404) throw new Error(`Expected 404, got ${status}`);
  }));

  // 9. Webhook — no Stripe signature should return 400
  results.push(await check('Webhook rejects missing signature', async () => {
    const { status } = await fetchJSON(`${SITE}/api/webhook`, {
      method: 'POST',
      body: JSON.stringify({ type: 'test' }),
    });
    if (status !== 400) throw new Error(`Expected 400 (bad signature), got ${status}`);
  }));

  // 10. Detect endpoint — missing body should not return 200
  results.push(await check('Detect endpoint rejects empty request', async () => {
    const { status } = await fetchJSON(`${SITE}/api/detect`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (status === 200) throw new Error('Empty body returned 200 — should be 4xx/5xx');
  }));

  // 11. Extension manifest version consistency
  results.push(await check('Extension manifest version readable', async () => {
    const manifestPath = path.resolve(__dirname, '../../Faux-Spy-Chrome-Ext/faux-spy-extension/manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found at expected path');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.version) throw new Error('No version field in manifest.json');
    console.log(`    (extension v${manifest.version})`);
  }));

  // 12. Pro page accessible
  results.push(await check('Pro pricing page loads', async () => {
    const { status } = await fetchRaw(`${SITE}/pro`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
  }));

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const results = await runChecks();
  const failed = results.filter(r => !r.pass);
  const passed = results.filter(r => r.pass);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed.length}/${results.length} checks passed`);

  // Skip GitHub Issue management if running locally (no GH_TOKEN)
  if (!process.env.GH_TOKEN) {
    if (failed.length) {
      console.log('\n❌ Failures (no GH_TOKEN set — skipping issue management):');
      failed.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
      process.exit(1);
    }
    console.log('\n✅ All checks passed.');
    return;
  }

  const openIssuesRaw = gh(`issue list --state open --search "${ALERT_TITLE} in:title" --json number,title`);
  const openIssues = JSON.parse(openIssuesRaw || '[]');

  if (failed.length > 0) {
    const failList = failed.map(f => `- **${f.name}**: ${f.error}`).join('\n');
    const body = `## ${failed.length} function check(s) failed

${failList}

**Passed:** ${passed.length}/${results.length} checks
**Checked at:** ${new Date().toISOString()}
**Site:** ${SITE}

> This issue closes automatically when all checks pass.`;

    if (openIssues.length === 0) {
      ghWithFile(`issue create --title "${ALERT_TITLE} — ${failed.map(f => f.name).join(', ')}"`, body);
      console.log('\n🚨 Alert issue opened.');
    } else {
      const num = openIssues[0].number;
      ghWithFile(`issue comment ${num}`, `Still failing at ${new Date().toISOString()}.\n\n${failList}`);
      console.log(`\n🚨 Commented on existing issue #${num}.`);
    }
    process.exit(1);
  } else {
    for (const issue of openIssues) {
      ghWithFile(`issue close ${issue.number} --comment`, `✅ All function checks recovered at ${new Date().toISOString()}. ${passed.length}/${results.length} checks passing.`);
      console.log(`✅ Closed alert issue #${issue.number}.`);
    }
    console.log('\n✅ All checks passed.');
  }
}

main().catch(err => {
  console.error('Function audit failed unexpectedly:', err.message);
  process.exit(1);
});
