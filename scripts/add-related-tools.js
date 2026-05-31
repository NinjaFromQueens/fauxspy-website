'use strict';
const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..', 'pages');

const detectors = [
  { slug: 'midjourney-detector',       name: 'Midjourney',          stat: 'v7 hardest to detect (24% open-source accuracy)' },
  { slug: 'dalle-detector',            name: 'DALL-E / ChatGPT',    stat: '31% open-source accuracy; 94% with enterprise tools' },
  { slug: 'stable-diffusion-detector', name: 'Stable Diffusion',    stat: 'v1.4 = 73% detectable; most widespread open-source' },
  { slug: 'firefly-detector',          name: 'Adobe Firefly',       stat: 'v4 = 18% accuracy — one of hardest to detect' },
  { slug: 'adobe-firefly-detector',    name: 'Adobe Firefly',       stat: 'v4 = 18% accuracy — one of hardest to detect' },
  { slug: 'flux-detector',             name: 'Flux / FLUX.1',       stat: 'Flux Dev = 21% accuracy; fastest-growing open-source 2024-26' },
  { slug: 'leonardo-detector',         name: 'Leonardo AI',         stat: 'Popular for character art; style consistency feature' },
  { slug: 'ideogram-detector',         name: 'Ideogram',            stat: 'Best for text-in-images; 40 free generations per day' },
  { slug: 'runway-detector',           name: 'Runway Gen-4',        stat: 'Top-tier AI video generator' },
  { slug: 'sora-detector',             name: 'Sora (OpenAI)',       stat: 'High public awareness; 2024 controversy' },
  { slug: 'pika-detector',             name: 'Pika',                stat: 'Leading AI video; consumer-facing' },
  { slug: 'kling-detector',            name: 'Kling 3.0',           stat: 'Leading AI video 2026; competitive vs Sora' },
  { slug: 'grok-detector',             name: 'Grok Imagine (xAI)',  stat: '2025-26 deepfake/non-consensual image controversy' },
  { slug: 'imagen-detector',           name: 'Google Imagen 4',     stat: '19% open-source accuracy — extremely hard to detect' },
  { slug: 'canva-detector',            name: 'Canva AI',            stat: 'Mass market via Canva; non-technical users' },
  { slug: 'bing-image-creator-detector', name: 'Bing Image Creator', stat: 'Free DALL-E via Bing; hundreds of millions of users' },
  { slug: 'nightcafe-detector',        name: 'NightCafe',           stat: 'Community art platform; multiple model access' },
  { slug: 'recraft-detector',          name: 'Recraft',             stat: 'Brand-consistent style generation; growing B2B use' },
  { slug: 'copilot-image-detector',    name: 'Microsoft Copilot',   stat: 'Enterprise reach via Microsoft 365' },
  { slug: 'gan-detector',              name: 'ProGAN / StyleGAN',   stat: 'Older GANs; 82-87% detectable' },
];

const P1 = ['midjourney-detector', 'dalle-detector', 'stable-diffusion-detector', 'flux-detector', 'grok-detector'];

function getRelated(slug) {
  const others = detectors.filter(d => d.slug !== slug);
  const sorted = [
    ...others.filter(d => P1.includes(d.slug)),
    ...others.filter(d => !P1.includes(d.slug)),
  ];
  // Deduplicate by name (firefly vs adobe-firefly)
  const seen = new Set();
  return sorted.filter(d => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  }).slice(0, 5);
}

function buildRelatedSection(slug) {
  const self = detectors.find(d => d.slug === slug);
  const related = getRelated(slug);
  const listItems = related.map(d =>
    `          <li><a href="/${d.slug}">${d.name} image detector</a> — ${d.stat}</li>`
  ).join('\n');

  return [
    '',
    '      <div class="landing-section">',
    `        <h2>Other AI generators Faux Spy detects</h2>`,
    `        <p>Faux Spy detects images from all major AI generators — not just ${self ? self.name : 'this one'}. The same Chrome extension, one click, any website.</p>`,
    '        <ul style="margin:1rem 0 0;padding-left:1.5rem;line-height:2.2;">',
    listItems,
    '        </ul>',
    '      </div>',
    '',
  ].join('\n');
}

let updated = 0, skipped = 0;

for (const det of detectors) {
  const filePath = path.join(PAGES_DIR, `${det.slug}.html`);
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP (missing): ${det.slug}`);
    skipped++;
    continue;
  }

  let html = fs.readFileSync(filePath, 'utf8');

  if (html.includes('Other AI generators Faux Spy detects')) {
    console.log(`SKIP (already done): ${det.slug}`);
    skipped++;
    continue;
  }

  const insertPoint = '<div class="landing-cta">';
  if (!html.includes(insertPoint)) {
    console.log(`SKIP (no cta): ${det.slug}`);
    skipped++;
    continue;
  }

  const section = buildRelatedSection(det.slug);
  html = html.replace(insertPoint, `${section}\n      ${insertPoint}`);
  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`Updated: ${det.slug}`);
  updated++;
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
