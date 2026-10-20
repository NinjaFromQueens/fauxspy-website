// checkout.js — starts Stripe Checkout from any [data-checkout="<plan>"]
// button or link (homepage pricing cards and /pro). Plans: monthly, yearly,
// video-monthly, video-yearly. Links keep their href as a no-JS fallback.

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);

  // ?promo=CODE is applied at checkout; Stripe shows the actual discount.
  const promo = (params.get('promo') || '').trim();
  const promoBanner = document.getElementById('promo-banner');
  if (promo && promoBanner) {
    document.getElementById('promo-label').textContent = promo.toUpperCase();
    promoBanner.style.display = 'block';
  }

  const cancelledNotice = document.getElementById('checkout-cancelled');
  if (params.get('cancelled') === 'true' && cancelledNotice) {
    cancelledNotice.style.display = 'block';
  }

  document.querySelectorAll('[data-checkout]').forEach(button => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      if (button.getAttribute('aria-busy') === 'true') return;

      const plan = button.dataset.checkout;
      const originalText = button.textContent;
      const errorEl = errorFor(button);
      errorEl.style.display = 'none';

      button.setAttribute('aria-busy', 'true');
      if ('disabled' in button) button.disabled = true;
      button.textContent = 'Opening secure checkout…';

      try {
        const response = await fetch('/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan, ...(promo ? { promoCode: promo } : {}) })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.url) {
          throw new Error(data.message || 'Checkout is unavailable right now.');
        }
        if (!data.url.startsWith('https://checkout.stripe.com/')) {
          throw new Error('Unexpected checkout address.');
        }
        if (promo && data.promoApplied === false &&
            !confirm(`Promo code "${promo.toUpperCase()}" isn't valid any more, so you'd pay the full price.\n\nContinue to checkout?`)) {
          reset();
          return;
        }
        window.location.href = data.url;
      } catch (error) {
        errorEl.textContent = (error.message === 'Failed to fetch'
          ? 'Network error. Check your connection'
          : error.message.replace(/\.$/, '')) + '. Please try again, or email hello@fauxspy.com.';
        errorEl.style.display = 'block';
        reset();
      }

      function reset() {
        button.removeAttribute('aria-busy');
        if ('disabled' in button) button.disabled = false;
        button.textContent = originalText;
      }
    });
  });

  // Coming back from Stripe with the Back button restores this page from the
  // browser's cache, buttons still saying "Opening secure checkout…".
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
  });

  function errorFor(button) {
    let el = button.parentElement.querySelector('.checkout-error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'checkout-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'display:none;margin:10px 0 0;font-size:13px;color:#f87171;text-align:center;';
      button.insertAdjacentElement('afterend', el);
    }
    return el;
  }
});
