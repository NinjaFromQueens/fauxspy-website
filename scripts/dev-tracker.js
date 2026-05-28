/**
 * Faux Spy Dev Tracker
 * Reads recent git commits from both repos, uses Claude Haiku to summarize
 * what was built/changed, and prepends an entry to dev-log.md.
 *
 * Usage: node scripts/dev-tracker.js
 * Required env: ANTHROPIC_API_KEY
 * Optional env: GIT_COMMIT_SHA (set by GitHub Actions)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { default: Anthropic } = require('@anthropic-ai/sdk');

const DEV_LOG = path.resolve(__dirname, '..', 'dev-log.md');
const MAX_DAYS = 90; // rolling window

function getCommits(repoPath, since = '2 days ago', maxCount = 20) {
  try {
    const out = execSync(
      `git -C "${repoPath}" log --oneline --no-merges --since="${since}" -n ${maxCount}`,
      { encoding: 'utf8' }
    ).trim();
    return out.length ? out.split('\n') : [];
  } catch {
    return [];
  }
}

function getRepoVersion(repoPath) {
  try {
    const manifestPath = path.join(repoPath, 'faux-spy-extension', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || null;
    }
  } catch {}
  return null;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function pruneOldEntries(content) {
  // Keep entries from the last MAX_DAYS days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const lines = content.split('\n');
  const keepLines = [];
  let skip = false;

  for (const line of lines) {
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      skip = dateMatch[1] < cutoffStr;
    }
    if (!skip) keepLines.push(line);
  }

  return keepLines.join('\n');
}

async function summarizeCommits(commits, version) {
  if (!commits.length) return null;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `These are git commits from the Faux Spy project (Chrome extension + website):

${commits.join('\n')}

Summarize what was built or changed in 3-6 plain English bullet points.
Rules:
- Each bullet starts with "- "
- Focus on WHAT changed from the user's perspective, not implementation details
- Group related changes into one bullet if possible
- Skip commit hashes, merge commits, and chore/bot commits like "update state [skip ci]"
- If the commits are all bot/chore commits with no real changes, return exactly: SKIP
- Keep each bullet under 100 characters
- Do not add a heading or preamble, just the bullets`
    }]
  });

  const text = response.content[0]?.text?.trim() || '';
  if (text === 'SKIP' || !text.includes('-')) return null;
  return text;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  const websiteRepo = path.resolve(__dirname, '..');
  const extensionRepo = path.resolve(__dirname, '../../Faux-Spy-Chrome-Ext');

  // Collect commits from both repos since yesterday
  const since = '25 hours ago'; // slightly more than 1 day to catch CI timing gaps
  const websiteCommits = getCommits(websiteRepo, since);
  const extCommits = getCommits(extensionRepo, since);

  // Filter out bot/noise commits
  const noisePattern = /\[skip ci\]|chore: update|Merge pull request/i;
  const allCommits = [...websiteCommits, ...extCommits]
    .filter(c => !noisePattern.test(c));

  console.log(`📝 Commits found: ${allCommits.length} (website: ${websiteCommits.length}, extension: ${extCommits.length})`);

  if (allCommits.length === 0) {
    console.log('No significant commits to track today. Skipping.');
    return;
  }

  const version = getRepoVersion(extensionRepo);
  const summary = await summarizeCommits(allCommits, version);

  if (!summary) {
    console.log('No meaningful changes to summarize. Skipping.');
    return;
  }

  const versionTag = version ? ` — v${version}` : '';
  const dateHeader = `## ${today()}${versionTag}`;

  const newEntry = `${dateHeader}\n${summary}\n`;

  // Read existing log or create fresh
  let existing = '';
  if (fs.existsSync(DEV_LOG)) {
    existing = fs.readFileSync(DEV_LOG, 'utf8');
  }

  // Strip the file header if present (we'll re-add it)
  const headerEnd = existing.indexOf('\n## ');
  const header = headerEnd > 0 ? existing.slice(0, headerEnd + 1) : '# Faux Spy Dev Log\n\nAutomatic record of what was built and changed. Updated on every push to main.\n\n';
  const body = headerEnd > 0 ? existing.slice(headerEnd + 1) : existing;

  // Don't duplicate today's entry
  if (body.startsWith(dateHeader)) {
    // Append to today's existing entry
    const afterHeader = body.indexOf('\n## ', 3);
    const todayContent = afterHeader > 0 ? body.slice(0, afterHeader) : body;
    const rest = afterHeader > 0 ? body.slice(afterHeader) : '';
    const merged = `${todayContent.trimEnd()}\n${summary.split('\n').filter(l => !todayContent.includes(l)).join('\n')}\n`;
    const updated = header + merged + rest;
    fs.writeFileSync(DEV_LOG, pruneOldEntries(updated), 'utf8');
  } else {
    const updated = header + newEntry + '\n' + body;
    fs.writeFileSync(DEV_LOG, pruneOldEntries(updated), 'utf8');
  }

  console.log(`✅ dev-log.md updated:\n${newEntry}`);
}

main().catch(err => {
  console.error('Dev tracker failed:', err.message);
  process.exit(1);
});
