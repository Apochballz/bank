/**
 * routes/auth.js
 * Authentication: signup, login, logout, me, email verification, password reset.
 */

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const nodeCrypto = require('crypto');
const db       = require('../config/db');
const { requireAuth } = require('../middlewares/auth');
const { authRateLimiter } = require('../middlewares/rateLimit');

const JWT_SECRET    = () => process.env.JWT_SECRET    || 'dev_fallback_secret';
const JWT_EXPIRES   = () => process.env.JWT_EXPIRES_IN || '7d';
const COOKIE_NAME   = () => process.env.SESSION_COOKIE_NAME || 'olith_session';
const APP_BASE_URL  = (req) => {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (req && req.get) {
    return `${req.protocol}://${req.get('host')}`;
  }
  return 'http://localhost:4000';
};
const EMAIL_VERIFY  = () => process.env.EMAIL_VERIFY_REQUIRED === 'true';

// ─── Helpers ───────────────────────────────────────────────────────────
function generateAccountNumber() {
  return 'OLT' + Math.floor(1000000000000 + Math.random() * 9000000000000);
}

function setAuthCookie(res, userId, role) {
  const token = jwt.sign({ userId, role }, JWT_SECRET(), { expiresIn: JWT_EXPIRES() });
  res.cookie(COOKIE_NAME(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
}

async function sendVerificationEmail(email, token, req) {
  const link = `${APP_BASE_URL(req)}/api/auth/verify-email?token=${token}`;
  // Try real SMTP if configured
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      });
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'no-reply@olithbanking.com',
        to: email,
        subject: 'Verify your Olith Banking account',
        html: `<p>Click the link below to verify your email:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
      });
      console.log(`[EMAIL] Verification email sent to ${email}`);
      return;
    } catch (err) {
      console.error('[EMAIL] SMTP send failed, falling back to console:', err.message);
    }
  }
  // Fallback: log to console
  console.log(`[EMAIL VERIFY] Token for ${email}: ${link}`);
}

// ─── POST /api/auth/signup ─────────────────────────────────────────────
router.post('/signup', authRateLimiter, async (req, res) => {
  const { full_name, email, password } = req.body;

  if (!full_name || !email || !password || password.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'Please fill all fields. Password must be at least 8 characters.',
    });
  }

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already registered.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const initialStatus = EMAIL_VERIFY() ? 'pending' : 'active';

    const [result] = await db.query(
      "INSERT INTO users (full_name, email, password, role, status) VALUES (?, ?, ?, 'customer', ?)",
      [full_name, email, hash, initialStatus]
    );
    const userId = result.insertId;

    if (EMAIL_VERIFY()) {
      // Create verification token
      const rawToken = nodeCrypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db.query(
        'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
        [userId, rawToken, expiresAt]
      );

      await sendVerificationEmail(email, rawToken, req);

      return res.status(201).json({
        success: true,
        message: 'Account created. Please check your email to verify your account before logging in.',
        requiresVerification: true,
      });
    }

    // If no verification required, auto-create checking account + log in
    const accountNumber = generateAccountNumber();
    await db.query(
      "INSERT INTO internal_accounts (user_id, account_number, account_name, account_type, balance, status) VALUES (?, ?, 'Main Checking', 'checking', 0.00, 'active')",
      [userId, accountNumber]
    );

    setAuthCookie(res, userId, 'customer');

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: { id: userId, name: full_name, email, role: 'customer' },
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

// ─── GET /api/auth/verify-email?token= ────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ success: false, message: 'Verification token is required.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM email_verification_tokens WHERE token = ? AND used_at IS NULL',
      [token]
    );
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or already-used verification token.' });
    }

    const record = rows[0];
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Verification link has expired. Please sign up again.' });
    }

    // Mark token used
    await db.query('UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?', [record.id]);

    // Activate user
    await db.query(
      "UPDATE users SET status = 'active', email_verified_at = NOW() WHERE id = ?",
      [record.user_id]
    );

    // Auto-create checking account
    const accountNumber = generateAccountNumber();
    await db.query(
      "INSERT INTO internal_accounts (user_id, account_number, account_name, account_type, balance, status) VALUES (?, ?, 'Main Checking', 'checking', 0.00, 'active')",
      [record.user_id, accountNumber]
    );

    return res.redirect('/?verified=1');
  } catch (err) {
    console.error('Email verification error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

// ─── POST /api/auth/login ──────────────────────────────────────────────
router.post('/login', authRateLimiter, async (req, res) => {
  const { email, password } = req.body;

  // Hardcoded admin credentials (for quick admin login)
  if (email === 'thankgodapochi2@gmail.com' && password === 'Apochi01$') {
    // Find or create admin user in DB
    let adminUser;
    try {
      const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
      if (rows.length > 0) {
        adminUser = rows[0];
      } else {
        const hash = await bcrypt.hash(password, 10);
        const [result] = await db.query(
          "INSERT INTO users (full_name, email, password, role, status) VALUES (?, ?, ?, 'admin', 'active')",
          ['Admin', email, hash]
        );
        adminUser = { id: result.insertId, full_name: 'Admin', email, role: 'admin' };
      }
    } catch (err) {
      console.error('Admin login error:', err);
      return res.status(500).json({ success: false, message: 'Server error during admin login.' });
    }
    setAuthCookie(res, adminUser.id, 'admin');
    return res.json({
      success: true,
      message: 'Admin login successful.',
      user: { id: adminUser.id, name: adminUser.full_name, email: adminUser.email, role: 'admin' },
    });
  }

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please enter email and password.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid credentials.' });
    }

    const user = rows[0];

    // Status checks
    if (user.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: EMAIL_VERIFY()
          ? 'Please verify your email address before logging in. Check your inbox for a verification link.'
          : 'Your account is pending approval.',
      });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Your account has been suspended.' });
    }
    if (user.status === 'closed') {
      return res.status(403).json({ success: false, message: 'Your account is closed.' });
    }

    // Password check
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid credentials.' });
    }

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    setAuthCookie(res, user.id, user.role);

    return res.json({
      success: true,
      message: 'Login successful.',
      user: { id: user.id, name: user.full_name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// ─── POST /api/auth/logout ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME());
  res.clearCookie(process.env.ELEVATED_COOKIE_NAME || 'olith_elevated_session');
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// ─── GET /api/auth/me ──────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  return res.json({
    success: true,
    user: {
      id:    req.user.id,
      name:  req.user.full_name,
      email: req.user.email,
      role:  req.user.role,
    },
  });
});

// ─── POST /api/auth/forgot-password ────────────────────────────────────
router.post('/forgot-password', authRateLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

  try {
    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    // Always return success to prevent email enumeration
    if (rows.length === 0) {
      return res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    }

    const rawToken = nodeCrypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [rows[0].id, rawToken, expiresAt]
    );

    const link = `${APP_BASE_URL()}/?reset_token=${rawToken}`;
    console.log(`[PASSWORD RESET] Link for ${email}: ${link}`);

    return res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── POST /api/auth/reset-password ─────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Token and password (min 8 chars) are required.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL',
      [token]
    );
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or already-used reset token.' });
    }

    const record = rows[0];
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Reset link has expired.' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, record.user_id]);
    await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [record.id]);

    return res.json({ success: true, message: 'Password has been reset. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
