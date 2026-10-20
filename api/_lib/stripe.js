// One place for the Stripe client and the API version every endpoint uses.

const Stripe = require('stripe');

const STRIPE_API_VERSION = '2026-09-30.endive';

function getStripe() {
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// Stripe Managed Payments makes Stripe (selling through Link) the merchant of
// record, so it calculates, collects and remits sales tax and VAT. It only
// works once Stripe has approved the account, so it's switched on with
// STRIPE_MANAGED_PAYMENTS=true rather than unconditionally.
function managedPaymentsEnabled() {
  return process.env.STRIPE_MANAGED_PAYMENTS === 'true';
}

function managedPayments() {
  return managedPaymentsEnabled() ? { managed_payments: { enabled: true } } : {};
}

module.exports = { getStripe, managedPayments, managedPaymentsEnabled, STRIPE_API_VERSION };
