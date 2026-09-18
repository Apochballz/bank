const Stripe = require('stripe');

let stripeClient;

function getStripeClient() {
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    const error = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to use bank connection features.');
    error.code = 'STRIPE_NOT_CONFIGURED';
    throw error;
  }

  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

module.exports = new Proxy({}, {
  get(_target, property) {
    return getStripeClient()[property];
  },
});
