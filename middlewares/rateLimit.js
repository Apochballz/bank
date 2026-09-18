/**
 * middlewares/rateLimit.js
 * Auth brute-force protection + Plaid link-token rate limits.
 */

const rateLimit = require('express-rate-limit');

/**
 * Auth limiter: 5 attempts per 15 minutes per IP.
 * Applied to POST /api/auth/login and POST /api/auth/signup.
 */
const authRateLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    message: 'Too many attempts. Please wait 15 minutes before trying again.',
  },
  skipSuccessfulRequests: true,
});

/**
 * Plaid link-token limiter: 5 requests per hour per IP.
 * Applied to POST /api/plaid/create_link_token.
 */
const plaidLinkRateLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many bank-link attempts. Please try again in an hour.',
  },
});

module.exports = { authRateLimiter, plaidLinkRateLimiter };
