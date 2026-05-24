/**
 * Faux Spy API Health Monitor
 * Calls /api/health, opens a GitHub Issue if any check fails, closes it when recovered.
 *
 * Usage: node scripts/health-monitor.js
 * Required env: ADMIN_TOKEN, GH_TOKEN (auto-set in GitHub Actions)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEALTH_URL = `https://fauxspy.com/api/health`;
const REPO = 'NinjaFromQueens/fauxspy-website';
const ALERT_TITLE = '⚠️ API Health Alert — Detection APIs down';

function gh(args) {
  return execSync(`gh ${args} --repo ${REPO}`, { encoding: 'utf8' }).trim();
}

function ghWithFile(args, body) {
  const tmp = path.join(os.tmpdir(), `health-${Date.now()}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    execSync(`gh ${args} --body-file "${tmp}" --repo ${REPO}`, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  if (!process.env.ADMIN_TOKEN) {
    console.error('❌ ADMIN_TOKEN is required');
    process.exit(1);
  }

  console.log('🔍 Checking API health...\n');

  let health;
  try {
    const resp = await fetch(`${HEALTH_URL}?token=${process.env.ADMIN_TOKEN}`, {
      signal: AbortSignal.timeout(20000),
    });
    health = await resp.json();
  } catch (err) {
    // Can't reach the health endpoint — Vercel itself may be down
    health = {
      overall: 'fail',
      checkedAt: new Date().toISOString(),
      checks: {
        vercel: { status: 'fail', error: `Cannot reach /api/health: ${err.message}` },
      },
    };
  }

  console.log('Result:', JSON.stringify(health, null, 2));

  // Find any open alert issues
  const openIssuesRaw = gh(`issue list --state open --search "${ALERT_TITLE} in:title" --json number,title`);
  const openIssues = JSON.parse(openIssuesRaw || '[]');

  if (health.overall === 'fail') {
    const failedChecks = Object.entries(health.checks)
      .filter(([, v]) => v.status === 'fail')
      .map(([name, v]) => `- **${name}**: ${v.error || 'unknown error'}`)
      .join('\n');

    const body = `## Detection API is down

The extension will show errors for all users until this is resolved.

## Failed checks

${failedChecks}

**Checked at:** ${health.checkedAt}

> This issue closes automatically when the API recovers.`;

    if (openIssues.length === 0) {
      ghWithFile(`issue create --title "${ALERT_TITLE}"`, body);
      console.log('\n⚠️  Alert issue opened.');
    } else {
      const num = openIssues[0].number;
      ghWithFile(`issue comment ${num}`, `Still failing at ${health.checkedAt}.\n\n${failedChecks}`);
      console.log(`\n⚠️  Commented on existing issue #${num}.`);
    }
  } else {
    // Healthy — close any open alerts
    for (const issue of openIssues) {
      ghWithFile(`issue close ${issue.number} --comment`, `✅ API recovered at ${health.checkedAt}. All checks passing.`);
      console.log(`✅ Closed alert issue #${issue.number}.`);
    }
    if (openIssues.length === 0) {
      console.log('✅ All checks passed. No open alerts.');
    }
  }
}

main().catch(err => {
  console.error('Health monitor failed:', err.message);
  process.exit(1);
});
