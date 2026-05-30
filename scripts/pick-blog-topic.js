'use strict';

/**
 * Blog Topic Picker
 * Reads existing blog posts, finds the next unwritten topic from the list,
 * and writes it to GITHUB_OUTPUT for the auto-blog workflow to consume.
 *
 * Usage: node scripts/pick-blog-topic.js
 * Output: writes BLOG_TOPIC and BLOG_CATEGORY to $GITHUB_OUTPUT
 */

const fs = require('fs');
const path = require('path');

const BLOG_DIR = path.resolve(__dirname, '..', 'blog');

// 20 topics covering high-value catfishing/AI detection search terms.
// One per week = ~5 months of content. Add more at the bottom when needed.
const TOPICS = [
  { topic: 'how to tell if a dating profile is fake', category: 'Online Safety' },
  { topic: 'catfishing statistics 2026', category: 'Scams' },
  { topic: 'ai face generators used by catfishers', category: 'AI Detection' },
  { topic: 'reverse image search guide for dating apps', category: 'Online Safety' },
  { topic: 'romance scam red flags', category: 'Scams' },
  { topic: 'how to spot a fake tinder profile', category: 'Dating Safety' },
  { topic: 'deepfake detection tools comparison', category: 'AI Detection' },
  { topic: 'stolen photos catfishing how it works', category: 'Scams' },
  { topic: 'online dating safety tips', category: 'Online Safety' },
  { topic: 'fake instagram profiles how to identify them', category: 'Dating Safety' },
  { topic: 'bumble fake profiles spotting guide', category: 'Dating Safety' },
  { topic: 'ai generated photos vs real photos differences', category: 'AI Detection' },
  { topic: 'how catfishers target victims', category: 'Scams' },
  { topic: 'hinge safety features review', category: 'Dating Safety' },
  { topic: 'what is sextortion and how to avoid it', category: 'Online Safety' },
  { topic: 'romance scam recovery steps', category: 'Scams' },
  { topic: 'how to report a catfish', category: 'Online Safety' },
  { topic: 'google reverse image search tutorial', category: 'Online Safety' },
  { topic: 'best free tools to verify someone online', category: 'AI Detection' },
  { topic: 'signs you are being catfished', category: 'Scams' },

  // Senior Safety cluster — older adults targeted by AI scams, adult children as install vector
  { topic: 'how AI scams target seniors on Facebook and email', category: 'Senior Safety' },
  { topic: 'grandparent scam AI voice clone how it works', category: 'Senior Safety' },
  { topic: 'how to protect elderly parents from online scams', category: 'Senior Safety' },
  { topic: 'romance scams targeting widows and widowers', category: 'Senior Safety' },
  { topic: 'signs your parent is being catfished online', category: 'Senior Safety' },
  { topic: 'fake Medicare and Social Security scams using deepfakes', category: 'Senior Safety' },
  { topic: 'AI generated images older adults cannot detect', category: 'Senior Safety' },
  { topic: 'how to set up scam protection on a parents computer', category: 'Senior Safety' },
];

function topicToSlug(t) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function getExistingSlugs() {
  try {
    return fs.readdirSync(BLOG_DIR)
      .filter(f => f.endsWith('.html') && f !== 'index.html')
      .map(f => f.replace(/\.html$/, ''));
  } catch {
    return [];
  }
}

function writeOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  } else {
    // Local testing fallback
    console.log(`${key}=${value}`);
  }
}

async function generateFreshTopics() {
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Generate 10 blog topic ideas for Faux Spy, a Chrome extension that detects AI-generated images.
Target keywords: catfishing, AI detection, deepfakes, online dating safety, fake profiles, romance scams.
Focus on topics people actually search for with buying or learning intent.
Return JSON only: [{"topic":"...","category":"Online Safety|AI Detection|Scams|Dating Safety"}]`
    }]
  });
  const raw = response.content[0]?.text || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  try { return match ? JSON.parse(match[0]) : []; } catch { return []; }
}

function appendTopicsToFile(newTopics) {
  const src = fs.readFileSync(__filename, 'utf8');
  const arrStart = src.indexOf('const TOPICS = [');
  if (arrStart === -1) { console.warn('  Could not find TOPICS array'); return; }
  const closeIdx = src.indexOf('\n];', arrStart);
  if (closeIdx === -1) { console.warn('  Could not find TOPICS closing bracket'); return; }
  const newEntries = newTopics.map(t =>
    `  { topic: '${t.topic.replace(/'/g, "\\'")}', category: '${t.category}' },`
  ).join('\n');
  const updated = src.slice(0, closeIdx) + '\n' + newEntries + src.slice(closeIdx);
  fs.writeFileSync(__filename, updated, 'utf8');
  console.log(`  ✅ Appended ${newTopics.length} new topics to TOPICS list`);
}

async function main() {
  const existingSlugs = new Set(getExistingSlugs());
  console.log(`Existing blog posts: ${existingSlugs.size}`);

  let next = TOPICS.find(({ topic }) => !existingSlugs.has(topicToSlug(topic)));

  if (!next) {
    console.log('All static topics published — generating fresh topics via Claude...');
    try {
      const newTopics = await generateFreshTopics();
      if (newTopics.length) {
        appendTopicsToFile(newTopics);
        next = newTopics[0];
      }
    } catch (err) {
      console.warn(`  Topic generation failed: ${err.message}`);
    }
  }

  if (!next) {
    console.log('No topics available. Add topics to TOPICS list manually.');
    writeOutput('BLOG_TOPIC', '');
    process.exit(0);
  }

  console.log(`Next topic: "${next.topic}" (${next.category})`);
  writeOutput('BLOG_TOPIC', next.topic);
  writeOutput('BLOG_CATEGORY', next.category);
}

main().catch(err => {
  console.error('Topic picker failed:', err.message);
  process.exit(1);
});
