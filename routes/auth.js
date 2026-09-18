const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabase = require('../config/supabaseClient');
const { requireAuth } = require('../middlewares/auth');
const { authRateLimiter } = require('../middlewares/rateLimit');

const jwtSecret = () => process.env.JWT_SECRET || 'dev_fallback_secret';
const cookieName = () => process.env.SESSION_COOKIE_NAME || 'olith_session';
const appBaseUrl = (req) => process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`);
const emailVerificationRequired = () => process.env.EMAIL_VERIFY_REQUIRED === 'true';

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function setAuthCookie(res, user) {
  const token = jwt.sign({ userId: user.id, role: user.role }, jwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.cookie(cookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
async function findUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('id, full_name, email, password_hash, role, status').eq('email', email).maybeSingle();
  if (error) throw error;
  return data;
}
async function createDefaultAccount(userId) {
  const { error } = await supabase.from('accounts').insert({ user_id: userId, account_name: 'Main Checking', balance_cents: 0 });
  if (error && error.code !== '23505') throw error;
}
async function sendVerificationEmail(email, token, req) {
  const link = `${appBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
      await transporter.sendMail({ from: process.env.EMAIL_FROM || 'no-reply@olithbanking.com', to: email, subject: 'Verify your Olith Banking account', html: `<p>Verify your account:</p><p><a href="${link}">${link}</a></p>` });
      return;
    } catch (error) { console.error('[v0] Verification email failed:', error.message); }
  }
  console.log(`[EMAIL VERIFY] ${link}`);
}

router.post('/signup', authRateLimiter, async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (fullName.length < 2 || !email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ success: false, message: 'Enter a valid name and email. Password must be at least 8 characters.' });
  try {
    if (await findUserByEmail(email)) return res.status(409).json({ success: false, message: 'Email already registered. Try logging in instead.' });
    const { data: user, error } = await supabase.from('users').insert({ full_name: fullName, email, password_hash: await bcrypt.hash(password, 12), role: 'user', status: emailVerificationRequired() ? 'pending' : 'active' }).select('id, full_name, email, role, status').single();
    if (error) throw error;
    if (emailVerificationRequired()) {
      const token = crypto.randomBytes(32).toString('hex');
      const { error: tokenError } = await supabase.from('email_verification_tokens').insert({ user_id: user.id, token, expires_at: new Date(Date.now() + 86400000).toISOString() });
      if (tokenError) throw tokenError;
      await sendVerificationEmail(email, token, req);
      return res.status(201).json({ success: true, requiresVerification: true, message: 'Account created. Check your email to verify it before logging in.' });
    }
    await createDefaultAccount(user.id);
    setAuthCookie(res, user);
    return res.status(201).json({ success: true, message: 'Account created successfully.', user: { id: user.id, name: user.full_name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('[v0] Signup error:', { message: error.message, code: error.code });
    return res.status(500).json({ success: false, message: error.code === '42P01' ? 'Database setup is incomplete. Run the Supabase schema, then try again.' : 'Unable to create your account right now. Please try again.' });
  }
});

router.post('/login', authRateLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ success: false, message: 'Enter your email and password.' });
  try {
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (user.status === 'pending') return res.status(403).json({ success: false, message: 'Please verify your email before logging in.' });
    if (['suspended', 'closed'].includes(user.status)) return res.status(403).json({ success: false, message: 'This account is not active.' });
    setAuthCookie(res, user);
    return res.json({ success: true, message: 'Login successful.', user: { id: user.id, name: user.full_name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('[v0] Login error:', { message: error.message, code: error.code });
    return res.status(500).json({ success: false, message: error.code === '42P01' ? 'Database setup is incomplete. Run the Supabase schema, then try again.' : 'Unable to sign you in right now. Please try again.' });
  }
});

router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ success: false, message: 'Verification token is required.' });
  try {
    const { data: record, error } = await supabase.from('email_verification_tokens').select('id, user_id, expires_at').eq('token', token).is('used_at', null).maybeSingle();
    if (error) throw error;
    if (!record || new Date(record.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This verification link is invalid or expired.' });
    const { error: userError } = await supabase.from('users').update({ status: 'active' }).eq('id', record.user_id);
    if (userError) throw userError;
    await supabase.from('email_verification_tokens').update({ used_at: new Date().toISOString() }).eq('id', record.id);
    await createDefaultAccount(record.user_id);
    return res.redirect('/login?verified=1');
  } catch (error) {
    console.error('[v0] Email verification error:', error.message);
    return res.status(500).json({ success: false, message: 'Verification is temporarily unavailable.' });
  }
});

router.post('/logout', (req, res) => { res.clearCookie(cookieName(), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }); return res.json({ success: true, message: 'Logged out successfully.' }); });
router.get('/me', requireAuth, (req, res) => res.json({ success: true, user: { id: req.user.id, name: req.user.full_name, full_name: req.user.full_name, email: req.user.email, role: req.user.role } }));

module.exports = router;
