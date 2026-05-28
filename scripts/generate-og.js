'use strict';
// Generates og-image.png for Faux Spy
// Usage: node scripts/generate-og.js

const path = require('path');
const sharp = require('sharp');

const WIDTH = 1200;
const HEIGHT = 630;
const OUT = path.join(__dirname, '..', 'og-image.png');

// Build SVG — brand colors match the site (#667eea → #764ba2 gradient)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea"/>
      <stop offset="100%" style="stop-color:#764ba2"/>
    </linearGradient>
    <linearGradient id="card" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:rgba(255,255,255,0.12)"/>
      <stop offset="100%" style="stop-color:rgba(255,255,255,0.04)"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

  <!-- Subtle noise overlay via semi-transparent shapes -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.08)"/>

  <!-- Card -->
  <rect x="80" y="80" width="1040" height="470" rx="24" fill="url(#card)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>

  <!-- Top badge -->
  <rect x="492" y="116" width="216" height="36" rx="18" fill="rgba(251,191,36,0.22)" stroke="rgba(251,191,36,0.5)" stroke-width="1"/>
  <text x="600" y="139" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" fill="#fbbf24" text-anchor="middle" letter-spacing="2">PRO CHROME EXTENSION</text>

  <!-- Main emoji/icon area -->
  <text x="600" y="295" font-family="system-ui, -apple-system, sans-serif" font-size="88" text-anchor="middle">🕵️</text>

  <!-- Main headline -->
  <text x="600" y="375" font-family="system-ui, -apple-system, sans-serif" font-size="58" font-weight="800" fill="white" text-anchor="middle" letter-spacing="-1">Faux Spy</text>

  <!-- Subtitle -->
  <text x="600" y="430" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="rgba(255,255,255,0.85)" text-anchor="middle">AI Image &amp; Deepfake Detector</text>

  <!-- Feature pills -->
  <rect x="200" y="468" width="240" height="40" rx="20" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
  <text x="320" y="493" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="white" text-anchor="middle">Right-click any image</text>

  <rect x="480" y="468" width="240" height="40" rx="20" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
  <text x="600" y="493" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="white" text-anchor="middle">Works on 10+ platforms</text>

  <rect x="760" y="468" width="240" height="40" rx="20" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
  <text x="880" y="493" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="white" text-anchor="middle">Free to start</text>

  <!-- URL watermark -->
  <text x="600" y="540" font-family="system-ui, -apple-system, sans-serif" font-size="16" fill="rgba(255,255,255,0.5)" text-anchor="middle" letter-spacing="1">fauxspy.com</text>
</svg>`;

async function generate() {
  await sharp(Buffer.from(svg))
    .png({ quality: 95, compressionLevel: 8 })
    .toFile(OUT);
  console.log('✅ og-image.png generated:', OUT);
}

generate().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
