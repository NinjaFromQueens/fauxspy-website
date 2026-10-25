'use strict';

// ============================================================================
// BUY TOKENS PAGE
// ============================================================================

let currentLicenseKey = null;
let selectedPack = null;

// ── DOM references ────────────────────────────────────────────────────────────
const licenseInput  = document.getElementById('licenseKeyInput');
const checkBtn      = document.getElementById('checkLicenseBtn');
const balanceDisplay = document.getElementById('balanceDisplay');
const balanceSub    = document.getElementById('balanceSubscription');
const balanceTopup  = document.getElementById('balanceTopup');
const balanceTotal  = document.getElementById('balanceTotal');
const licenseError  = document.getElementById('licenseError');
const buyBtn        = document.getElementById('buyBtn');
const statusMsg     = document.getElementById('statusMsg');

// ── Pack selection ────────────────────────────────────────────────────────────
document.querySelectorAll('.pack-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.pack-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedPack = card.dataset.pack;
    updateBuyButton();
  });
});

function updateBuyButton() {
  if (selectedPack && currentLicenseKey) {
    buyBtn.disabled = false;
    const packNames = { small: '50 Tokens ($1.99)', medium: '200 Tokens ($5.99)', large: '500 Tokens ($11.99)' };
    buyBtn.innerHTML = `<span>Buy ${packNames[selectedPack] || selectedPack}</span>`;
  } else if (selectedPack && !currentLicenseKey) {
    buyBtn.disabled = true;
    buyBtn.innerHTML = '<span>Enter license key first</span>';
  } else {
    buyBtn.disabled = true;
    buyBtn.innerHTML = '<span>Select a Pack to Continue</span>';
  }
}

// ── License check ─────────────────────────────────────────────────────────────
checkBtn.addEventListener('click', checkLicense);
licenseInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') checkLicense();
});

async function checkLicense() {
  const key = licenseInput.value.trim().toUpperCase();

  hideStatus();
  balanceDisplay.classList.remove('visible');
  licenseError.classList.remove('visible');

  if (!key) {
    showLicenseError('Please enter your license key.');
    return;
  }

  checkBtn.textContent = 'Checking...';
  checkBtn.disabled = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('/api/validate-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await res.json();

    if (!data.valid) {
      showLicenseError(data.message || 'License not found. Check for typos.');
      currentLicenseKey = null;
    } else {
      currentLicenseKey = key;

      balanceSub.textContent   = (data.tokenBalance  || 0).toLocaleString();
      balanceTopup.textContent = (data.topupBalance   || 0).toLocaleString();
      balanceTotal.textContent = ((data.tokenBalance || 0) + (data.topupBalance || 0)).toLocaleString();
      balanceDisplay.classList.add('visible');
    }
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError' ? 'Request timed out. Please try again.' : 'Network error. Please try again.';
    showLicenseError(msg);
    currentLicenseKey = null;
  } finally {
    checkBtn.textContent = 'Check Balance';
    checkBtn.disabled = false;
    updateBuyButton();
  }
}

// ── Checkout ──────────────────────────────────────────────────────────────────
buyBtn.addEventListener('click', startCheckout);

async function startCheckout() {
  if (!selectedPack || !currentLicenseKey) return;

  buyBtn.disabled = true;
  buyBtn.innerHTML = '<span>Redirecting to checkout...</span>';
  hideStatus();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'topup',
        licenseKey: currentLicenseKey,
        packSize: selectedPack,
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await res.json();

    if (!res.ok || !data.url) {
      throw new Error(data.message || 'Could not create checkout session.');
    }

    if (!data.url.startsWith('https://')) {
      throw new Error('Invalid checkout URL received from server.');
    }

    window.location.href = data.url;

  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError' ? 'Request timed out. Please try again.'
      : err.message === 'Failed to fetch' ? 'Network error. Check your connection and try again.'
      : err.message;
    showStatus('error', msg);
    buyBtn.disabled = false;
    updateBuyButton();
  }
}

// ── URL params (success / cancelled callbacks) ────────────────────────────────
// The inline script in the page head moved the query string here before
// clearing it from the address bar.
const pageParams = new URLSearchParams(window.__pageParams || window.location.search);

function handleUrlParams() {
  if (pageParams.get('success') === 'true') {
    waitForTopUp(pageParams.get('session_id'));
  } else if (pageParams.get('cancelled') === 'true') {
    showStatus('error', 'Checkout was cancelled. No charge was made.');
  }
}

// The Stripe webhook adds the tokens a moment after payment, so confirm
// only once they're really there.
function waitForTopUp(sessionId) {
  const started = Date.now();
  showStatus('success', 'Payment received. Adding your tokens…');
  if (!sessionId) return;

  const poll = async () => {
    try {
      const res = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'complete' && data.kind === 'topup') {
        showStatus('success', `✅ ${data.tokens} tokens added. Your balance is now ${Number(data.balance).toLocaleString()} tokens.`);
        return;
      }
      if (res.status === 400 || data.status === 'expired') return;
    } catch { /* retry below */ }
    if (Date.now() - started > 60000) {
      showStatus('success', "Payment received. Your tokens will appear within a few minutes, and we'll email you when they do.");
      return;
    }
    setTimeout(poll, 2000);
  };
  poll();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLicenseError(msg) {
  licenseError.textContent = msg;
  licenseError.classList.add('visible');
}

function showStatus(type, msg) {
  statusMsg.className = `status-msg ${type} visible`;
  statusMsg.textContent = msg;
}

function hideStatus() {
  statusMsg.className = 'status-msg';
  statusMsg.textContent = '';
}

// ── Init ──────────────────────────────────────────────────────────────────────
handleUrlParams();

// Pre-fill license key from query param (e.g. linked from popup)
// A ?key= link wins; otherwise use the key the site's checkers saved on this
// device (see /photo-check.js), so phone users don't have to paste it again.
let savedKey = '';
try { savedKey = localStorage.getItem('fs_license') || ''; } catch (e) { /* storage blocked */ }
const keyParam = pageParams.get('key') || savedKey;
if (keyParam) {
  licenseInput.value = keyParam.toUpperCase();
  checkLicense();
}
