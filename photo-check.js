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
      poll.innerHTML = answer === 'no'
        ? '<p class="photo-check-poll-thanks">Thanks, that helps us decide.</p>'
        : '<p class="photo-check-poll-thanks">Thanks! Want an email if we build it? <a href="/app">Join the app list</a></p>';
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
    const proBar = mountProBar(root);

    function show(state) {
      drop.hidden = state !== 'idle';
      busy.hidden = state !== 'busy';
      out.hidden = state !== 'done';
    }

    function finish(html, askAboutApp) {
      out.innerHTML = html + '<button type="button" class="btn btn-secondary photo-check-again">Check another photo</button>' +
        (askAboutApp && !pollAnswered() ? pollHtml() : '');
      out.querySelector('.photo-check-again').addEventListener('click', () => {
        input.value = '';
        show('idle');
        input.focus();
      });
      const enterKey = out.querySelector('[data-act="enter-key"]');
      if (enterKey) enterKey.addEventListener('click', () => proBar.open());
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
        return fail(proKey()
          ? 'You\'ve used your 3 free checks for today, and your Pro key wasn\'t accepted. <a href="/account">Check your subscription</a>.'
          : 'You\'ve used your 3 free checks for today. They reset at midnight, or <a href="/pro">get Pro</a> for 200 checks a month. <button type="button" class="photo-check-link" data-act="enter-key">Have Pro? Enter your key</button>', true);
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
        (data.proHint && !proKey() ? '<p class="photo-check-pro">🔒 <a href="/pro">' + esc(data.proHint) + '</a></p>' : ''),
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

  // /check uploads through its own form but needs the same shrinking and Pro handling.
  window.FauxSpyPhotoCheck = { prepareImage, proRequestFields, applyProResponse, proKey };
})();
