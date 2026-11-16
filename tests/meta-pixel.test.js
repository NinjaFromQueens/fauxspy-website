// The Meta Pixel's on/off rules, as promised in the privacy policy, and which
// pages load it. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { decide, needsConsent, storeOf } = require('../meta-pixel');

const ROOT = path.join(__dirname, '..');
const US = 'America/New_York';
const UK = 'Europe/London';

test('a privacy signal turns the pixel off, whatever else is true', () => {
  for (const choice of [null, 'yes', 'no']) {
    for (const timeZone of [US, UK, '']) {
      assert.equal(decide({ privacySignal: true, choice, timeZone }), 'off');
    }
  }
});

test('outside Europe the pixel is on until the visitor turns it off', () => {
  assert.equal(decide({ privacySignal: false, choice: null, timeZone: US }), 'on');
  assert.equal(decide({ privacySignal: false, choice: 'no', timeZone: US }), 'off');
  assert.equal(decide({ privacySignal: false, choice: 'yes', timeZone: US }), 'on');
});

test('in Europe the visitor is asked first, and their answer sticks', () => {
  assert.equal(decide({ privacySignal: false, choice: null, timeZone: UK }), 'ask');
  assert.equal(decide({ privacySignal: false, choice: 'yes', timeZone: UK }), 'on');
  assert.equal(decide({ privacySignal: false, choice: 'no', timeZone: UK }), 'off');
});

test('consent is required across the EU, UK and EEA, and when the zone is unknown', () => {
  for (const tz of ['Europe/London', 'Europe/Berlin', 'Europe/Dublin', 'Europe/Zurich', 'Europe/Oslo', 'Atlantic/Reykjavik',
    'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Asia/Nicosia', 'Asia/Famagusta', 'Arctic/Longyearbyen', '', undefined]) {
    assert.equal(needsConsent(tz), true, tz);
  }
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Toronto', 'Australia/Sydney', 'Asia/Tokyo']) {
    assert.equal(needsConsent(tz), false, tz);
  }
});

test('store clicks are recognised by store', () => {
  assert.equal(storeOf('https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg'), 'chrome');
  assert.equal(storeOf('https://addons.mozilla.org/addon/faux-spy-ai-image-detector/'), 'firefox');
  assert.equal(storeOf('https://microsoftedge.microsoft.com/addons/detail/faux-spy-ai-image-detec/kgahaelogloejdlomjbfpfebecpgmjdh'), 'edge');
  assert.equal(storeOf('https://www.fauxspy.com/pro'), null);
});

test('the pixel is never on the checkout, account, token, success or admin pages', () => {
  for (const page of ['pro.html', 'account.html', 'buy-tokens.html', 'success.html', 'admin.html', 'goodbye.html', 'app.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(!html.includes('meta-pixel.js') && !html.includes('fbevents.js'), `${page} must not load the Meta Pixel`);
  }
});

test('nothing loads Meta\'s script directly, so every page goes through the rules above', () => {
  const offenders = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    if (['node_modules', '.vercel', '.git', 'tests'].includes(e.name)) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|js)$/.test(e.name) && e.name !== 'meta-pixel.js' && fs.readFileSync(p, 'utf8').includes('fbevents.js')) offenders.push(path.relative(ROOT, p));
  });
  walk(ROOT);
  assert.deepEqual(offenders, []);
});
