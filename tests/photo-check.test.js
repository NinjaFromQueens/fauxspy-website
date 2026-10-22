// Platform pages get the inline photo checker and phone-friendly buttons.
// Pure string transforms only.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { transform, PAGES } = require('../scripts/add-photo-check');

const CWS = 'https://chromewebstore.google.com/detail/faux-spy-ai-image-detecto/npdkneknfigfcledlnmedkobcjdcigcg';
const AMO = 'https://addons.mozilla.org/addon/faux-spy-ai-image-detector/';

// The shape of a platform page as generated (nav, hero, mid-page CTA, closing CTA).
const PAGE = `<body>
        <a href="${CWS}" class="btn btn-primary btn-small" target="_blank" rel="noopener">Add to Chrome</a>
      <div class="landing-hero">
        <h1>Tinder Fake Profile Detector</h1>
        <p class="landing-subtitle">Intro.</p>
        <div data-geo="quick-answer"><p>Quick answer.</p></div>
        <a href="${CWS}" class="btn btn-primary btn-large" target="_blank" rel="noopener">Add to Chrome — Free</a>
          <a href="${AMO}" class="btn btn-secondary" target="_blank" rel="noopener">Add to Firefox — Free</a>
        <p class="landing-note">3 checks/day free.</p>
      </div>
      <div class="inline-cta">
        <a href="${CWS}" class="btn btn-primary" target="_blank" rel="noopener" style="display:inline-block;">Add to Chrome</a>
      </div>
      <div class="landing-cta">
        <h2>Closing</h2>
        <a href="${CWS}" class="btn btn-primary btn-large" target="_blank" rel="noopener">Add to Chrome — Free</a>
          <a href="${AMO}" class="btn btn-secondary" target="_blank" rel="noopener">Add to Firefox — Free</a>
      </div>
</body>`;

test('the checker sits under the hero subtitle, with the extension buttons right after it', () => {
  const { html } = transform(PAGE, PAGES.tinder);
  const order = ['landing-subtitle', 'class="photo-check"', 'class="desktop-only"', 'mobile-only">On a computer?', 'data-geo="quick-answer"']
    .map(s => html.indexOf(s));
  assert.ok(order.every(i => i > 0), 'all hero parts present');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'hero parts in order');
  assert.match(html, /data-platform="Tinder"/);
  assert.match(html, /<script defer src="\/photo-check\.js"><\/script>\n<\/body>/);
});

test('every extension button is hidden on phones, and each spot gets a jump to the checker', () => {
  const { html } = transform(PAGE, PAGES.tinder);
  const chromeButtons = html.match(new RegExp(`<a href="${CWS.replace(/[.?]/g, '\\$&')}"[^>]*>`, 'g'));
  assert.equal(chromeButtons.length, 4);
  // the hero pair is inside a .desktop-only wrapper; the rest carry the class
  const outsideWrapper = html.replace(/<div class="desktop-only">[\s\S]*?<\/div>/, '');
  for (const a of outsideWrapper.match(/<a href="https:\/\/(chromewebstore|addons\.mozilla)[^>]*>/g)) {
    assert.match(a, /desktop-only/, a);
  }
  assert.equal((html.match(/href="#photo-check" class="btn btn-primary[^"]*mobile-only"/g) || []).length, 2);
});

test('a page with an unexpected layout is reported, not half-edited', () => {
  assert.throws(() => transform(PAGE.replace('class="landing-cta"', 'class="other-cta"'), PAGES.tinder), /bottom buttons/);
});
