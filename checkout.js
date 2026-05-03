// checkout.js - Handles Stripe checkout button clicks on landing page

document.addEventListener('DOMContentLoaded', () => {
  const checkoutButtons = document.querySelectorAll('[data-checkout]');
  
  checkoutButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      
      const plan = button.dataset.checkout; // 'monthly' or 'yearly'
      const originalText = button.textContent;
      
      // Show loading state
      button.disabled = true;
      button.textContent = 'Loading...';
      
      try {
        // Call our API to create a Stripe checkout session
        const response = await fetch('/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan })
        });
        
        if (!response.ok) {
          throw new Error('Failed to create checkout session');
        }
        
        const { url, error } = await response.json();
        
        if (error) {
          throw new Error(error);
        }
        
        // Redirect to Stripe Checkout
        window.location.href = url;
        
      } catch (error) {
        console.error('Checkout error:', error);
        alert('Something went wrong. Please try again or email hello@fauxspy.com');
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });
  
  // Show success message if user just completed checkout
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('cancelled') === 'true') {
    console.log('Checkout was cancelled');
  }
});
