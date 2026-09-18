const stripe = require('../services/stripeClient');

function verifyStripeWebhook(req, res, next) {
  const sig = req.headers['stripe-signature'];
  try {
    req.stripeEvent = stripe.webhooks.constructEvent(
      req.body, // must be the raw Buffer, not parsed JSON
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    next();
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }
}

module.exports = { verifyStripeWebhook };
