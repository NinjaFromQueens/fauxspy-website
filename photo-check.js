// Inline photo checker for the platform pages (/instagram, /tinder, ...).
// Most visitors to those pages arrive on a phone, where the extension can't
// be installed, so the page itself has to be able to check a photo.
// The markup lives in each page (it renders without JS); this binds it.
// Same /api/detect call, anonymous user id and free limit as /check.
(function () {
  'use strict';

  // Vercel rejects request bodies over ~4.5 MB and base64 adds a third, so
  // big phone photos are shrunk first. 2048px keeps the detail detection uses.
  const MAX_SIDE = 2048;
  const MAX_BYTES = 3 * 1024 * 1024;
  const SENDABLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Returns a data URL small enough to upload, re-encoding to JPEG only when
  // the file is too big or in a format the detector may not read (HEIC etc.).
  async function prepareImage(file) {
    const dataUrl = await readAsDataUrl(file);
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size <= MAX_BYTES && SENDABLE_TYPES.includes(file.type)) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  function getUserId() {
    try {
      let uid = localStorage.getItem('fs_uid');
      if (!uid) {
        uid = 'fs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
        localStorage.setItem('fs_uid', uid);
      }
      return uid;
    } catch (e) {
      return 'fs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    }
  }

  // Custom events show in Vercel Web Analytics, so we can see whether the
  // checker turns search visits into checks and installs.
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  function track(name, data) {
    try { window.va('event', { name: name, data: data }); } catch (e) { /* analytics is optional */ }
  }

  // ── Phone funnel ────────────────────────────────────────────────────────
  // Anonymous counts per step, split phone/desktop (/api/funnel, read in the
  // admin dashboard): shows where phone visitors drop off between a visit
  // and a trial, and whether the home-screen app gets used.
  function isPhone() { return matchMedia('(hover: none) and (pointer: coarse)').matches; }
  function funnel(step) {
    try {
      const body = JSON.stringify({ step: step, device: isPhone() ? 'phone' : 'desktop' });
      const sent = navigator.sendBeacon && navigator.sendBeacon('/api/funnel', new Blob([body], { type: 'application/json' }));
      if (!sent) fetch('/api/funnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* counting is optional */ }
  }

  // ── Home-screen app ─────────────────────────────────────────────────────
  // Before building a native app, see whether phone visitors will keep a web
  // one: fauxspy.com/check installs to the home screen (manifest.webmanifest)
  // and, on Android, appears in the Share menu (sw.js hands shared photos to
  // /check).
  function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

  function addHeadLink(rel, href) {
    if (document.querySelector('link[rel="' + rel + '"]')) return;
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    document.head.appendChild(link);
  }
  addHeadLink('manifest', '/manifest.webmanifest');
  addHeadLink('apple-touch-icon', '/apple-touch-icon.png');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/share-target' }).catch(function () { /* sharing just won't work */ });
  }

  let installPrompt = null;
  let installOfferCounted = false;
  window.addEventListener('beforeinstallprompt', function (e) {
    installPrompt = e;
    document.querySelectorAll('[data-install-offer]').forEach(renderInstallOffer);
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    funnel('installed');
    track('App installed', {});
    document.querySelectorAll('[data-install-offer]').forEach(function (slot) {
      slot.innerHTML = '<p class="fs-install-done">Added! Faux Spy is on your home screen.</p>';
    });
  });
  try {
    if (isStandalone() && !sessionStorage.getItem('fs_app_open')) {
      sessionStorage.setItem('fs_app_open', '1');
      funnel('app_open');
    }
  } catch (e) { /* storage blocked: skip the count */ }

  const SHARE_ICON = '<svg class="fs-install-share" viewBox="0 0 24 24" width="16" height="16" aria-label="Share" role="img"><path fill="currentColor" d="M12 2l4 4-1.4 1.4L13 5.8V15h-2V5.8L9.4 7.4 8 6l4-4zM5 10h3v2H6v8h12v-8h-2v-2h3a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V11a1 1 0 011-1z"/></svg>';

  // Fills a [data-install-offer] slot on phones; empty on desktop or when
  // already running from the home screen.
  function renderInstallOffer(slot) {
    if (!isPhone() || isStandalone()) { slot.hidden = true; return; }
    let note, button = '';
    if (installPrompt) {
      note = 'Opens like an app, and you can share screenshots straight to it. Free, no app store.';
      button = '<button type="button" class="btn btn-primary fs-install-btn" data-act="install">Add</button>';
    } else if (isIOS()) {
      note = 'Tap ' + SHARE_ICON + ' <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Free, no app store.';
    } else {
      note = 'Open your browser menu (&#8942;) and tap <strong>Add to Home screen</strong> or <strong>Install app</strong>. Free, no app store.';
    }
    slot.hidden = false;
    slot.innerHTML = '<div class="fs-install">' +
      '<img src="/app-icons/app-icon-192.png" alt="" width="44" height="44" class="fs-install-icon">' +
      '<div class="fs-install-text"><p class="fs-install-title">Put Faux Spy on your home screen</p>' +
      '<p class="fs-install-note">' + note + '</p></div>' + button +
    '</div>';
    if (!installOfferCounted) {
      installOfferCounted = true;
      funnel('install_prompt');
      track('Install offer shown', { from: slot.dataset.installOffer || 'page', ios: isIOS() });
    }
    const btn = slot.querySelector('[data-act="install"]');
    if (btn) btn.addEventListener('click', async function () {
      if (!installPrompt) return;
      funnel('install_click');
      const prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      try { await prompt.userChoice; } catch (e) { /* the appinstalled event reports success */ }
      renderInstallOffer(slot);
    });
  }

  // The upgrade offer under a result or the daily-limit message. Its button
  // goes straight to Stripe checkout instead of stopping at /pro first: the
  // trial needs no card, and Stripe shows the price before anything starts.
  // Counted as "offer" in the funnel: it's only built when it's shown.
  function trialOfferHtml(from, primary) {
    funnel('offer');
    return '<div class="photo-check-offer" data-from="' + from + '">' +
      '<button type="button" class="btn ' + (primary ? 'btn-primary' : 'btn-secondary') + ' photo-check-trial" data-act="trial">Try Pro free for 7 days</button>' +
      '<p class="photo-check-offer-note">No card needed. Then $9.99/month if you keep it. <a href="/pro">Compare plans</a></p>' +
    '</div>';
  }

  async function startTrial(button) {
    if (button.getAttribute('aria-busy') === 'true') return;
    const from = button.closest('.photo-check-offer').dataset.from;
    button.dataset.label = button.textContent;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = 'Opening secure checkout…';
    track('Checkout started', { plan: 'monthly', page: location.pathname, from: from, promo: 'none' });
    funnel('offer_click');
    try {
      const r = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'monthly' }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url && d.url.startsWith('https://checkout.stripe.com/')) {
        funnel('checkout');
        location.href = d.url;
        return;
      }
    } catch (e) { /* the plans page has its own checkout buttons */ }
    location.href = '/pro';
  }

  document.addEventListener('click', function (e) {
    const trial = e.target.closest && e.target.closest('[data-act="trial"]');
    if (trial) return startTrial(trial);

    // Shows whether checks lead anyone to Pro, and from where: a result's Pro
    // hint, the daily-limit message, or a link elsewhere on the page.
    const link = e.target.closest && e.target.closest('a[href^="/pro"]');
    if (!link) return;
    const offer = link.closest('.photo-check-offer');
    const from = offer ? offer.dataset.from
      : link.closest('.photo-check-pro, #proHintBox') ? 'result'
      : link.closest('.photo-check-result, #limitBanner') ? 'limit' : 'page';
    track('Pro link click', { page: location.pathname, from: from });
  });

  // Back from Stripe restores the page from cache with the button still
  // saying "Opening secure checkout…".
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('[data-act="trial"][aria-busy]').forEach(function (b) {
      b.removeAttribute('aria-busy');
      b.disabled = false;
      b.textContent = b.dataset.label || 'Try Pro free for 7 days';
    });
  });

  const VERDICTS = {
    verified_real: { cls: 'is-real', label: 'Real Photo', desc: 'No signs of AI generation in this image.' },
    likely_real: { cls: 'is-real', label: 'Likely Real', desc: 'Very few AI signals: this looks like a real photograph.' },
    inconclusive: { cls: 'is-mixed', label: 'Inconclusive', desc: 'Mixed signals. Treat this profile with extra caution and check its other photos.' },
    digital_art: { cls: 'is-art', label: 'Digital Art', desc: 'This looks like digital artwork rather than a photograph.' },
    likely_ai: { cls: 'is-ai', label: 'Likely AI-Generated', desc: 'Strong signs this image was made by an AI generator.' },
    definitely_ai: { cls: 'is-ai', label: 'AI-Generated', desc: 'This image was almost certainly made by an AI generator.' },
    // Pro-only verdicts
    likely_ai_art: { cls: 'is-ai', label: 'Likely AI Art', desc: 'Strong signs this artwork was made by an AI generator.' },
    definitely_ai_art: { cls: 'is-ai', label: 'AI Art', desc: 'This artwork was almost certainly made by an AI generator.' },
    digital_art_verified: { cls: 'is-art', label: 'Digital Art', desc: 'This looks like digital artwork rather than a photograph.' },
    digital_art_uncertain: { cls: 'is-art', label: 'Digital Art', desc: 'This looks like digital artwork rather than a photograph.' },
    likely_real_manipulated: { cls: 'is-mixed', label: 'Possible Manipulation', desc: 'Looks like a real photo, but parts of it may have been edited or face-swapped.' },
    verified_real_manipulated: { cls: 'is-mixed', label: 'Possible Manipulation', desc: 'Looks like a real photo, but parts of it may have been edited or face-swapped.' },
  };

  const ERRORS = {
    'imageUrl or imageData required': 'Please choose a photo to check.',
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // One question after a result (or the daily limit), until answered: would
  // someone who just checked a photo use a phone app? Answers go to
  // /api/app-interest and decide whether the app gets built.
  const POLL_KEY = 'fs_app_poll';
  function pollAnswered() {
    try { return !!localStorage.getItem(POLL_KEY); } catch (e) { return false; }
  }
  function pollHtml() {
    return '<div class="photo-check-poll">' +
      '<p class="photo-check-poll-q">Would you use a Faux Spy app on your phone?</p>' +
      '<div class="photo-check-poll-opts">' +
        '<button type="button" class="btn btn-secondary" data-answer="iphone">Yes, on iPhone</button>' +
        '<button type="button" class="btn btn-secondary" data-answer="android">Yes, on Android</button>' +
        '<button type="button" class="btn btn-secondary" data-answer="no">No thanks</button>' +
      '</div>' +
    '</div>';
  }
  function bindPoll(container, platform) {
    const poll = container.querySelector('.photo-check-poll');
    if (!poll) return;
    poll.querySelectorAll('[data-answer]').forEach(btn => btn.addEventListener('click', () => {
      const answer = btn.dataset.answer;
      try { localStorage.setItem(POLL_KEY, answer); } catch (e) { /* the answer still counts */ }
      track('App interest', { page: platform, answer: answer });
      fetch('/api/app-interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: answer,
          page: location.pathname,
          touch: matchMedia('(hover: none) and (pointer: coarse)').matches,
          userId: getUserId(),
        }),
      }).catch(() => { /* a lost vote isn't worth bothering the visitor about */ });
      if (answer === 'no') {
        poll.innerHTML = '<p class="photo-check-poll-thanks">Thanks, that helps us decide.</p>';
      } else if (isPhone() && !isStandalone()) {
        // The home-screen version exists today, so offer it right away.
        poll.innerHTML = '<p class="photo-check-poll-thanks">Thanks! You can have it on your home screen now:</p>' +
          '<div data-install-offer="poll"></div>' +
          '<p class="photo-check-poll-thanks">Want an email if we build a full app? <a href="/app">Join the app list</a></p>';
        renderInstallOffer(poll.querySelector('[data-install-offer]'));
      } else {
        poll.innerHTML = '<p class="photo-check-poll-thanks">Thanks! Want an email if we build it? <a href="/app">Join the app list</a></p>';
      }
    }));
  }

  // ── Pro on the web ──────────────────────────────────────────────────────
  // Pro used to work only inside the extension, so someone who bought it on a
  // phone got a key they couldn't use anywhere. The key is remembered on this
  // device (the purchase page saves it too) and sent with every check.
  const LICENSE_KEY = 'fs_license';
  const BALANCE_KEY = 'fs_license_balance';
  const KEY_FORMAT = /^FAUX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  const proBars = [];

  function stored(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function proKey() { return stored(LICENSE_KEY); }
  function setPro(key, balance) {
    try {
      if (key) { localStorage.setItem(LICENSE_KEY, key); localStorage.setItem(BALANCE_KEY, String(balance)); }
      else { localStorage.removeItem(LICENSE_KEY); localStorage.removeItem(BALANCE_KEY); }
    } catch (e) { /* storage blocked: Pro lasts until the page closes */ }
    proBars.forEach(render => render());
    window.dispatchEvent(new Event('fauxspy:pro'));
  }

  // Extra fields for a /api/detect request.
  function proRequestFields() {
    const key = proKey();
    return key ? { licenseKey: key, isPro: true } : {};
  }

  // Keeps the shown balance in step with a /api/detect response. Returns a
  // note to show when the key stopped working.
  function applyProResponse(data) {
    if (data && data.proDenied) {
      setPro('', 0);
      return 'Your Pro key isn\'t active any more, so this used a free check. <a href="/account">Check your subscription</a>.';
    }
    if (data && typeof data.tokenBalance === 'number' && proKey()) {
      setPro(proKey(), data.tokenBalance + (data.topupBalance || 0));
    }
    return '';
  }

  function mountProBar(container) {
    const bar = document.createElement('div');
    bar.className = 'photo-check-pro-bar';
    container.appendChild(bar);

    function render() {
      if (proKey()) {
        const n = Number(stored(BALANCE_KEY) || 0);
        bar.innerHTML = '<span>⭐ <strong>Pro</strong> · ' + n.toLocaleString('en-US') + ' scan' + (n === 1 ? '' : 's') + ' left</span>' +
          '<button type="button" class="photo-check-link" data-act="remove">Remove key</button>';
        bar.querySelector('[data-act="remove"]').addEventListener('click', () => setPro('', 0));
        return;
      }
      bar.innerHTML =
        '<button type="button" class="photo-check-link" data-act="open">Have Pro? Enter your key</button>' +
        '<form class="photo-check-key-form" hidden>' +
          '<input type="text" class="photo-check-key-input" placeholder="FAUX-XXXX-XXXX-XXXX-XXXX" aria-label="Pro license key" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
          '<button type="submit" class="btn btn-secondary">Activate</button>' +
          '<p class="photo-check-key-msg" aria-live="polite"></p>' +
        '</form>';
      const open = bar.querySelector('[data-act="open"]');
      const form = bar.querySelector('form');
      open.addEventListener('click', () => {
        open.hidden = true;
        form.hidden = false;
        form.querySelector('input').focus();
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const msg = form.querySelector('.photo-check-key-msg');
        const key = form.querySelector('input').value.trim().toUpperCase();
        if (!KEY_FORMAT.test(key)) {
          msg.textContent = 'Keys look like FAUX-XXXX-XXXX-XXXX-XXXX. It\'s in your purchase email.';
          return;
        }
        msg.textContent = 'Checking your key…';
        try {
          const r = await fetch('/api/validate-license', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: key }),
          });
          const d = await r.json().catch(() => ({}));
          if (d.valid) {
            track('Pro key added', { page: location.pathname });
            setPro(key, (d.tokenBalance || 0) + (d.topupBalance || 0));
          } else {
            msg.textContent = d.message || d.error || 'That key didn\'t work. Check it and try again.';
          }
        } catch (err) {
          msg.textContent = 'Couldn\'t reach the server. Try again in a moment.';
        }
      });
    }

    proBars.push(render);
    render();
    return {
      open() {
        const btn = bar.querySelector('[data-act="open"]');
        if (btn) btn.click();
        bar.scrollIntoView({ block: 'nearest' });
      },
    };
  }

  function bind(root) {
    const input = root.querySelector('.photo-check-input');
    const drop = root.querySelector('.photo-check-drop');
    const busy = root.querySelector('.photo-check-busy');
    const out = root.querySelector('.photo-check-result');
    const platform = root.dataset.platform || '';
    mountProBar(root);

    function show(state) {
      drop.hidden = state !== 'idle';
      busy.hidden = state !== 'busy';
      out.hidden = state !== 'done';
    }

    // Out of free checks, "Check another photo" can't work, so the upgrade
    // offer is the only button (outOfChecks).
    // After a result: the app poll until it's answered, then the home-screen
    // offer (phones only; the slot stays empty elsewhere).
    function finish(html, askAboutApp, outOfChecks) {
      out.innerHTML = html +
        (outOfChecks ? '' : '<button type="button" class="btn btn-secondary photo-check-again">Check another photo</button>') +
        (askAboutApp ? (pollAnswered() ? '<div data-install-offer="result"></div>' : pollHtml()) : '');
      out.querySelectorAll('[data-install-offer]').forEach(renderInstallOffer);
      const again = out.querySelector('.photo-check-again');
      if (again) again.addEventListener('click', () => {
        input.value = '';
        show('idle');
        input.focus();
      });
      bindPoll(out, platform);
      show('done');
    }

    function fail(html, askAboutApp) {
      finish('<p class="photo-check-error">' + html + '</p>', askAboutApp);
    }

    async function check(file) {
      if (!file || !file.type.startsWith('image/')) return fail('That file isn\'t an image. Choose a photo or screenshot.');
      show('busy');
      track('Photo check started', { page: platform });
      funnel('check');

      let imageData;
      try {
        imageData = await prepareImage(file);
      } catch (e) {
        return fail('This photo couldn\'t be opened. Try a screenshot of it instead.');
      }

      let r, data;
      try {
        r = await fetch('/api/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign(
            { userId: getUserId(), pageHost: location.hostname, imageData: imageData, isVideoFrame: false },
            proRequestFields()
          )),
        });
        data = await r.json().catch(() => ({}));
      } catch (e) {
        return fail('Couldn\'t reach the checker. Check your connection and try again.');
      }

      if (r.status === 429 || data.error === 'DAILY_LIMIT_REACHED') {
        track('Photo check limit', { page: platform });
        funnel('limit');
        if (proKey()) {
          return fail('You\'ve used your 3 free checks for today, and your Pro key wasn\'t accepted. <a href="/account">Check your subscription</a>.');
        }
        return finish(
          '<p class="photo-check-error">You\'ve used your 3 free checks for today. They reset at midnight, or keep checking with Pro: 200 checks a month.</p>' +
          trialOfferHtml('limit', true),
          false, true
        );
      }
      if (r.status === 402 || data.error === 'TOKENS_EXHAUSTED') {
        applyProResponse({ tokenBalance: 0 });
        return fail('You\'ve used all your Pro scans for now. <a href="/buy-tokens">Top up</a>, or they refill when your plan renews.');
      }
      if (!r.ok || !data.success) {
        return fail(ERRORS[data.error] || (r.status === 503
          ? 'The checker is busy right now. Please try again in a moment.'
          : 'Something went wrong with this photo. Try a different photo or a screenshot of it.'));
      }

      const info = VERDICTS[data.verdict] || (data.isAI ? VERDICTS.likely_ai : VERDICTS.inconclusive);
      const prob = Math.round((data.aiProbability || 0) * 100);
      const proNote = applyProResponse(data);
      track('Photo check result', { page: platform, verdict: data.verdict || 'unknown', pro: !!proKey() });
      funnel('result');

      finish(
        '<div class="photo-check-verdict ' + info.cls + '">' +
          '<img class="photo-check-thumb" src="' + imageData + '" alt="">' +
          '<div>' +
            '<p class="photo-check-label">' + esc(data.verdictLabel || info.label) + '</p>' +
            '<p class="photo-check-desc">' + esc(info.desc) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="photo-check-meter" role="img" aria-label="AI likelihood ' + prob + ' percent">' +
          '<span style="width:' + prob + '%"></span>' +
        '</div>' +
        '<p class="photo-check-prob">AI likelihood: <strong>' + prob + '%</strong>. No detector is perfect: use this as one signal alongside the profile\'s history.</p>' +
        (proNote ? '<p class="photo-check-pro">' + proNote + '</p>' : '') +
        (data.proHint && !proKey() ? '<p class="photo-check-pro">🔒 ' + esc(data.proHint) + '</p>' + trialOfferHtml('result', false) : ''),
        true
      );
    }

    input.addEventListener('change', () => check(input.files[0]));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('is-over');
      check(e.dataTransfer.files[0]);
    });
  }

  document.querySelectorAll('.photo-check').forEach(bind);
  // /check has its own form; it marks where its Pro key bar goes.
  document.querySelectorAll('[data-pro-bar]').forEach(mountProBar);
  if (document.querySelector('.photo-check, [data-pro-bar]')) funnel('visit');
  document.querySelectorAll('[data-install-offer]').forEach(renderInstallOffer);

  // /check uploads through its own form but needs the same shrinking, Pro
  // handling and funnel counts.
  window.FauxSpyPhotoCheck = { prepareImage, proRequestFields, applyProResponse, proKey, trialOfferHtml, funnel };
})();
