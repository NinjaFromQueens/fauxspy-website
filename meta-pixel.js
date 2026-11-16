// Meta Pixel for fauxspy.com's public pages. It is deliberately not on the
// checkout, account, token or success pages, and never in the extension.
// What the privacy policy promises is enforced here: off for anyone sending a
// privacy signal, asked first where the law requires consent, and limited to
// page views and store clicks.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else factory().start();
})(this, function () {
  var PIXEL_ID = '1673270220999010';
  var KEY = 'fs_ad_choice';

  // The EU, UK and their neighbours require consent before an ad tracker
  // loads. The time zone is a good-enough stand-in for location that needs no
  // server call; an unknown zone is treated as needing consent.
  function needsConsent(timeZone) {
    return !timeZone || /^(Europe\/|Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$|Asia\/(Nicosia|Famagusta)$|Arctic\/Longyearbyen$)/.test(timeZone);
  }

  // 'on' loads the pixel, 'ask' shows the prompt, 'off' does neither.
  function decide(visitor) {
    if (visitor.privacySignal) return 'off';
    if (visitor.choice === 'yes') return 'on';
    if (visitor.choice === 'no') return 'off';
    return needsConsent(visitor.timeZone) ? 'ask' : 'on';
  }

  function storeOf(href) {
    if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(href)) return 'chrome';
    if (/addons\.mozilla\.org/.test(href)) return 'firefox';
    if (/microsoftedge\.microsoft\.com/.test(href)) return 'edge';
    return null;
  }

  function start() {
    var privacySignal = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';

    // Private windows can refuse storage; the choice then lasts for the page.
    var remembered = null;
    function getChoice() {
      try { return localStorage.getItem(KEY) || remembered; } catch (e) { return remembered; }
    }
    function setChoice(value) {
      remembered = value;
      try { localStorage.setItem(KEY, value); } catch (e) { /* kept in memory */ }
    }
    function timeZone() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; }
    }
    function state() {
      return decide({ privacySignal: privacySignal, choice: getChoice(), timeZone: timeZone() });
    }

    function load() {
      if (window.fbq) { window.fbq('consent', 'grant'); return; }
      var fbq = window.fbq = function () {
        fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
      };
      window._fbq = fbq;
      fbq.push = fbq;
      fbq.loaded = true;
      fbq.version = '2.0';
      fbq.queue = [];
      // Without these two, Meta's script also reports button clicks, form
      // fields and every history change. We only want page views.
      fbq.disablePushState = true;
      fbq('set', 'autoConfig', false, PIXEL_ID);
      fbq('init', PIXEL_ID);
      fbq('track', 'PageView');
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(script);
    }

    function choose(value) {
      setChoice(value);
      if (value === 'yes') load();
      else if (window.fbq) window.fbq('consent', 'revoke');
      closeBar();
    }

    var bar = null;
    function closeBar() {
      if (bar) { bar.remove(); bar = null; }
    }

    function addStyle() {
      var style = document.createElement('style');
      style.textContent =
        '.fs-ad-bar{position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;z-index:2147483000;' +
        'background:#111827;border:1px solid #334155;border-radius:16px;padding:18px 20px;color:#e2e8f0;' +
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.5)}' +
        '.fs-ad-bar p{margin:0 0 12px;color:#e2e8f0}.fs-ad-bar a{color:#fbbf24}' +
        '.fs-ad-bar .fs-ad-status{font-weight:700;color:#fff;margin-bottom:6px}' +
        '.fs-ad-actions{display:flex;flex-wrap:wrap;gap:10px}' +
        '.fs-ad-actions button{flex:1 1 140px;min-height:44px;border-radius:10px;border:1px solid #475569;background:#1f2937;' +
        'color:#f8fafc;font:600 14px/1 inherit;cursor:pointer;padding:0 16px}' +
        '.fs-ad-actions button:hover{border-color:#fbbf24}' +
        '.fs-ad-actions button[aria-pressed="true"]{border-color:#fbbf24;color:#fbbf24}' +
        '.fs-ad-link{color:inherit;text-decoration:underline;cursor:pointer}';
      document.head.appendChild(style);
    }

    function showBar(manage) {
      closeBar();
      var now = state();
      var html;
      if (privacySignal) {
        html = '<p class="fs-ad-status">Ad measurement is off.</p>' +
          '<p>Your browser asks sites not to track you, so the Meta Pixel stays off on fauxspy.com. <a href="/privacy#ads">Privacy policy</a></p>' +
          '<div class="fs-ad-actions"><button type="button" data-fs-ad="close">Close</button></div>';
      } else {
        html = (manage ? '<p class="fs-ad-status">Ad measurement is ' + (now === 'on' ? 'on' : 'off') + '.</p>' : '') +
          '<p>Can we use a Meta Pixel on this site? It tells Meta which pages you visit here, so we can see which of our ads work. ' +
          'It never sees the photos you check. <a href="/privacy#ads">Privacy policy</a></p>' +
          '<div class="fs-ad-actions">' +
          '<button type="button" data-fs-ad="yes" aria-pressed="' + (manage && now === 'on') + '">Allow</button>' +
          '<button type="button" data-fs-ad="no" aria-pressed="' + (manage && now === 'off') + '">Don\'t allow</button></div>';
      }
      bar = document.createElement('div');
      bar.className = 'fs-ad-bar';
      bar.setAttribute('role', 'dialog');
      bar.setAttribute('aria-label', 'Ad privacy choices');
      bar.innerHTML = html;
      bar.addEventListener('click', function (e) {
        var pick = e.target.getAttribute && e.target.getAttribute('data-fs-ad');
        if (pick === 'close') closeBar();
        else if (pick) choose(pick);
      });
      document.body.appendChild(bar);
    }

    function addFooterLink() {
      var link = document.createElement('a');
      link.href = '/privacy#ads';
      link.className = 'fs-ad-link';
      link.setAttribute('data-ad-choices', '');
      link.textContent = 'Ad privacy choices';
      var line = document.querySelector('.footer-bottom p');
      var row = document.querySelector('.footer-links');
      if (line) { line.appendChild(document.createTextNode(' · ')); line.appendChild(link); }
      else if (row) { link.className = (row.querySelector('a') || link).className; row.appendChild(link); }
    }

    function ready() {
      addStyle();
      addFooterLink();
      document.addEventListener('click', function (e) {
        var target = e.target.closest ? e.target.closest('a[href], [data-ad-choices]') : null;
        if (!target) return;
        if (target.hasAttribute('data-ad-choices')) { e.preventDefault(); showBar(true); return; }
        var store = storeOf(target.href || '');
        if (store && window.fbq && state() === 'on') window.fbq('trackCustom', 'InstallClick', { store: store });
      });
      if (state() === 'ask') showBar(false);
    }

    if (state() === 'on') load();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  }

  return { start: start, decide: decide, needsConsent: needsConsent, storeOf: storeOf, PIXEL_ID: PIXEL_ID };
});
