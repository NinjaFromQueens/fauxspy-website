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

  function bind(root) {
    const input = root.querySelector('.photo-check-input');
    const drop = root.querySelector('.photo-check-drop');
    const busy = root.querySelector('.photo-check-busy');
    const out = root.querySelector('.photo-check-result');
    const platform = root.dataset.platform || '';

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
          body: JSON.stringify({ userId: getUserId(), pageHost: location.hostname, imageData: imageData, isVideoFrame: false }),
        });
        data = await r.json().catch(() => ({}));
      } catch (e) {
        return fail('Couldn\'t reach the checker. Check your connection and try again.');
      }

      if (r.status === 429 || data.error === 'DAILY_LIMIT_REACHED') {
        track('Photo check limit', { page: platform });
        return fail('You\'ve used your 3 free checks for today. They reset at midnight, or <a href="/pro">get Pro</a> for 200 checks a month.', true);
      }
      if (!r.ok || !data.success) {
        return fail(ERRORS[data.error] || (r.status === 503
          ? 'The checker is busy right now. Please try again in a moment.'
          : 'Something went wrong with this photo. Try a different photo or a screenshot of it.'));
      }

      const info = VERDICTS[data.verdict] || (data.isAI ? VERDICTS.likely_ai : VERDICTS.inconclusive);
      const prob = Math.round((data.aiProbability || 0) * 100);
      track('Photo check result', { page: platform, verdict: data.verdict || 'unknown' });

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
        (data.proHint ? '<p class="photo-check-pro">🔒 <a href="/pro">' + esc(data.proHint) + '</a></p>' : ''),
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

  // /check uploads through its own form but needs the same shrinking.
  window.FauxSpyPhotoCheck = { prepareImage: prepareImage };
})();
