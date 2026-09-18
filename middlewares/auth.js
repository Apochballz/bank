/**
 * middlewares/auth.js
 * JWT-based authentication and authorization middlewares.
 */

const jwt  = require('jsonwebtoken');
const supabase = require('../config/supabaseClient');

const JWT_SECRET      = () => process.env.JWT_SECRET || 'dev_fallback_secret';
const COOKIE_NAME     = () => process.env.SESSION_COOKIE_NAME || 'olith_session';
const ELEVATED_COOKIE = () => process.env.ELEVATED_COOKIE_NAME || 'olith_elevated_session';

/**
 * requireAuth — validates the olith_session JWT cookie.
 * Attaches full user row to req.user.
 * 401 if missing / invalid / expired.
 */
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME()];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET());

    const { data: user, error } = await supabase
      .from('users')
      .select('id, full_name, email, phone, role, status')
      .eq('id', decoded.userId)
      .maybeSingle();
    if (error || !user) {
      return res.status(401).json({ success: false, message: 'User not found.' });
    }
    if (user.status === 'suspended' || user.status === 'closed') {
      return res.status(403).json({ success: false, message: 'Account is not active.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid session.' });
  }
}

/**
 * requireAdmin — checks req.user.role against admin_roles table.
 * Must be used AFTER requireAuth.
 * 403 if user does not have an admin-tier role.
 */
async function requireAdmin(req, res, next) {
  try {
    const { data: role, error } = await supabase
      .from('admin_roles')
      .select('name')
      .eq('name', req.user.role)
      .maybeSingle();
    if (error || !role) {
      return res.status(403).json({ success: false, message: 'Admin access required.' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Authorization check failed.' });
  }
}

/**
 * requireSuperAdmin — restricts to role='super_admin' specifically.
 * Used for restore_db, backup_db, admins_manage.
 */
function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin access required.' });
  }
  next();
}

/**
 * requireReauth — checks for a valid olith_elevated_session cookie.
 * The elevated cookie contains a JWT with a 15-minute max lifetime,
 * issued by POST /api/admin/reauth.
 */
function requireReauth(req, res, next) {
  try {
    const elevatedToken = req.cookies[ELEVATED_COOKIE()];
    if (!elevatedToken) {
      return res.status(401).json({
        success: false,
        message: 'Elevated session required. Please re-authenticate.',
        requireReauth: true,
      });
    }

    const decoded = jwt.verify(elevatedToken, JWT_SECRET());
    if (decoded.purpose !== 'elevated' || decoded.userId !== req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Invalid elevated session.',
        requireReauth: true,
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Elevated session expired. Please re-authenticate.',
      requireReauth: true,
    });
  }
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, requireReauth };
