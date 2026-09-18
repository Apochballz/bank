/**
 * routes/admin.js
 * Full admin API: users, accounts, transactions, cards, tickets,
 * reports, audit logs, system settings, backup/restore.
 */

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const { execFile } = require('child_process');
const nodeCrypto   = require('crypto');

const db     = require('../config/db');
const ledger = require('../services/ledger');
const { requireAuth, requireAdmin, requireSuperAdmin, requireReauth } = require('../middlewares/auth');

const JWT_SECRET      = () => process.env.JWT_SECRET || 'dev_fallback_secret';
const ELEVATED_COOKIE = () => process.env.ELEVATED_COOKIE_NAME || 'olith_elevated_session';
const ELEVATED_MINS   = () => parseInt(process.env.ELEVATED_SESSION_MINUTES) || 15;
// Vercel functions cannot write inside the deployed /var/task bundle. Use ephemeral
// /tmp storage there; local development keeps the persistent project backup folder.
const BACKUP_DIR      = process.env.VERCEL
  ? path.join('/tmp', 'olith-banking-backups')
  : path.join(__dirname, '..', 'backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// All admin routes require auth + admin role
router.use(requireAuth);
router.use(requireAdmin);

// ════════════════════════════════════════════════════════════
// REAUTH — elevated session for high-risk operations
// ════════════════════════════════════════════════════════════

router.post('/reauth', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: 'Password required.' });

  try {
    const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });

    const isMatch = await bcrypt.compare(password, rows[0].password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect password.' });
    }

    // Issue elevated session JWT (15 min)
    const elevatedToken = jwt.sign(
      { userId: req.user.id, purpose: 'elevated' },
      JWT_SECRET(),
      { expiresIn: `${ELEVATED_MINS()}m` }
    );

    res.cookie(ELEVATED_COOKIE(), elevatedToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ELEVATED_MINS() * 60 * 1000,
    });

    await ledger.logAudit(req.user.id, null, 'admin_reauth', 'users', req.user.id);
    return res.json({ success: true, message: 'Elevated session authorized.', expiresIn: ELEVATED_MINS() * 60 });
  } catch (err) {
    console.error('Reauth error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get('/users', async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.role, u.created_at, u.last_login,
        (SELECT COUNT(*) FROM internal_accounts a WHERE a.user_id = u.id) AS accounts_count,
        (SELECT COALESCE(SUM(a.balance), 0) FROM internal_accounts a WHERE a.user_id = u.id) AS total_balance
       FROM users u WHERE u.role = 'customer' ORDER BY u.id DESC`
    );
    return res.json({ success: true, users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, full_name, email, phone, role, status, email_verified_at, last_login, created_at FROM users WHERE id = ?',
      [req.params.id]
    );
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });

    const user = users[0];
    const [accounts]   = await db.query('SELECT * FROM internal_accounts WHERE user_id = ?', [user.id]);
    const [cards]      = await db.query('SELECT id, card_number, card_type, card_provider, expiry_date, status FROM cards WHERE user_id = ?', [user.id]);
    const [plaidItems] = await db.query('SELECT id, institution_name, status, created_at FROM plaid_items WHERE user_id = ?', [user.id]);

    return res.json({ success: true, user, accounts, cards, plaidItems });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/users', async (req, res) => {
  const { full_name, email, password, phone } = req.body;
  if (!full_name || !email) return res.status(400).json({ success: false, message: 'Name and email required.' });

  try {
    const hash = await bcrypt.hash(password || 'Temp@12345', 10);
    const [result] = await db.query(
      "INSERT INTO users (full_name, email, password, phone, role, status, email_verified_at) VALUES (?, ?, ?, ?, 'customer', 'active', NOW())",
      [full_name, email, hash, phone || null]
    );

    // Auto-create checking account
    const accNum = 'OLT' + Math.floor(1000000000000 + Math.random() * 9000000000000);
    await db.query(
      "INSERT INTO internal_accounts (user_id, account_number, account_name, account_type, balance, status) VALUES (?, ?, 'Main Checking', 'checking', 0.00, 'active')",
      [result.insertId, accNum]
    );

    await ledger.logAudit(req.user.id, result.insertId, 'user_create', 'users', result.insertId);
    return res.json({ success: true, message: 'User created.', userId: result.insertId });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/users/:id', async (req, res) => {
  const { full_name, email, phone, status } = req.body;
  try {
    const [old] = await db.query('SELECT full_name, email, phone, status FROM users WHERE id = ?', [req.params.id]);
    await db.query(
      'UPDATE users SET full_name = ?, email = ?, phone = ?, status = ? WHERE id = ?',
      [full_name, email, phone || null, status, req.params.id]
    );
    await ledger.logAudit(req.user.id, req.params.id, 'user_edit', 'users', req.params.id, old[0], { full_name, email, phone, status });
    return res.json({ success: true, message: 'User updated.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/users/:id/approve', async (req, res) => {
  await db.query("UPDATE users SET status = 'active', email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, req.params.id, 'approve_user', 'users', req.params.id);
  return res.json({ success: true, message: 'User approved.' });
});

router.post('/users/:id/suspend', async (req, res) => {
  await db.query("UPDATE users SET status = 'suspended' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, req.params.id, 'suspend_user', 'users', req.params.id);
  return res.json({ success: true, message: 'User suspended.' });
});

router.post('/users/:id/reactivate', async (req, res) => {
  await db.query("UPDATE users SET status = 'active' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, req.params.id, 'reactivate_user', 'users', req.params.id);
  return res.json({ success: true, message: 'User reactivated.' });
});

router.post('/users/:id/close', async (req, res) => {
  await db.query("UPDATE users SET status = 'closed' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, req.params.id, 'close_user', 'users', req.params.id);
  return res.json({ success: true, message: 'User account closed.' });
});

// ════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get('/accounts', async (req, res) => {
  try {
    const [accounts] = await db.query(
      'SELECT a.*, u.full_name, u.email FROM internal_accounts a JOIN users u ON a.user_id = u.id ORDER BY a.id DESC'
    );
    return res.json({ success: true, accounts });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/accounts', async (req, res) => {
  const { userId, accountType, accountName } = req.body;
  const accNum = 'OLT' + Math.floor(1000000000000 + Math.random() * 9000000000000);
  try {
    const [result] = await db.query(
      "INSERT INTO internal_accounts (user_id, account_number, account_name, account_type, balance, status) VALUES (?, ?, ?, ?, 0.00, 'active')",
      [userId, accNum, accountName || 'New Account', accountType || 'savings']
    );
    await ledger.logAudit(req.user.id, userId, 'account_create', 'internal_accounts', result.insertId);
    return res.json({ success: true, message: 'Account created.', accountNumber: accNum });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/accounts/:id/freeze', async (req, res) => {
  await db.query("UPDATE internal_accounts SET status = 'frozen' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, null, 'freeze_account', 'internal_accounts', req.params.id);
  return res.json({ success: true, message: 'Account frozen.' });
});

router.post('/accounts/:id/unfreeze', async (req, res) => {
  await db.query("UPDATE internal_accounts SET status = 'active' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, null, 'unfreeze_account', 'internal_accounts', req.params.id);
  return res.json({ success: true, message: 'Account unfrozen.' });
});

// ADD FUNDS — requires elevated session
router.post('/accounts/:id/add-funds', requireReauth, async (req, res) => {
  const { amount, reason } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await ledger.mutateBalance(
      parseInt(req.params.id), amt, 'credit', 'Adjustment',
      reason || 'Admin credit', 'admin_credit', conn
    );
    await ledger.logAudit(req.user.id, null, 'add_funds', 'internal_accounts', req.params.id, null, { amount: amt, reason }, conn);
    await conn.commit();
    return res.json({ success: true, message: 'Funds credited.', newBalance: result.newBalance });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ════════════════════════════════════════════════════════════
// TRANSACTION MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get('/transactions', async (req, res) => {
  try {
    const { status, type, from, to, page: p, limit: l } = req.query;
    const page   = Math.max(1, parseInt(p) || 1);
    const limit  = Math.min(200, parseInt(l) || 50);
    const offset = (page - 1) * limit;

    const conditions = [], params = [];
    if (status) { conditions.push('t.status = ?'); params.push(status); }
    if (type)   { conditions.push('t.transaction_type = ?'); params.push(type); }
    if (from)   { conditions.push('t.created_at >= ?'); params.push(from); }
    if (to)     { conditions.push('t.created_at <= ?'); params.push(to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM internal_transactions t ${where}`, params);
    const [transactions] = await db.query(
      `SELECT t.*,
        fa.account_number AS from_account_number, fu.full_name AS from_user,
        ta.account_number AS to_account_number,   tu.full_name AS to_user
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id LEFT JOIN users fu ON fa.user_id = fu.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id   LEFT JOIN users tu ON ta.user_id = tu.id
       ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return res.json({ success: true, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/transactions/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*,
        fa.account_number AS from_account_number, fu.full_name AS from_user,
        ta.account_number AS to_account_number,   tu.full_name AS to_user
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id LEFT JOIN users fu ON fa.user_id = fu.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id   LEFT JOIN users tu ON ta.user_id = tu.id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, transaction: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// APPROVE — requires elevated session
router.post('/transactions/:id/approve', requireReauth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [txns] = await conn.query('SELECT * FROM internal_transactions WHERE id = ? FOR UPDATE', [req.params.id]);
    if (txns.length === 0) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Not found.' }); }

    const txn = txns[0];
    if (txn.status !== 'pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Not pending.' }); }

    // Credit destination if applicable
    if (txn.to_account_id) {
      await conn.query(
        'UPDATE internal_accounts SET balance = balance + ? WHERE id = ?',
        [parseFloat(txn.amount), txn.to_account_id]
      );
    }

    await conn.query(
      "UPDATE internal_transactions SET status = 'completed', approved_by = ?, approved_at = NOW(), completed_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await ledger.logAudit(req.user.id, null, 'approve_txn', 'internal_transactions', req.params.id, null, null, conn);
    await conn.commit();
    return res.json({ success: true, message: 'Transaction approved.' });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// REJECT — requires elevated session
router.post('/transactions/:id/reject', requireReauth, async (req, res) => {
  const { reason } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [txns] = await conn.query('SELECT * FROM internal_transactions WHERE id = ? FOR UPDATE', [req.params.id]);
    if (txns.length === 0) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Not found.' }); }

    const txn = txns[0];
    if (txn.status !== 'pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Not pending.' }); }

    // Refund debit if applicable
    if (txn.from_account_id) {
      await conn.query(
        'UPDATE internal_accounts SET balance = balance + ? WHERE id = ?',
        [parseFloat(txn.total_amount), txn.from_account_id]
      );
    }

    await conn.query("UPDATE internal_transactions SET status = 'rejected', notes = ? WHERE id = ?", [reason || 'Rejected by admin', req.params.id]);
    await ledger.logAudit(req.user.id, null, 'reject_txn', 'internal_transactions', req.params.id, null, { reason }, conn);
    await conn.commit();
    return res.json({ success: true, message: 'Transaction rejected.' });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ════════════════════════════════════════════════════════════
// CARD MANAGEMENT
// ════════════════════════════════════════════════════════════

router.post('/cards/issue', async (req, res) => {
  const { userId, accountId, cardType, cardProvider } = req.body;
  const cardNumber = '5412' + Math.floor(100000000000 + Math.random() * 900000000000).toString();
  const cvv = Math.floor(100 + Math.random() * 900).toString();
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 4);
  const expiryStr = String(expiry.getMonth() + 1).padStart(2, '0') + '/' + String(expiry.getFullYear()).slice(-2);

  try {
    const [result] = await db.query(
      "INSERT INTO cards (user_id, account_id, card_number, card_type, card_provider, expiry_date, cvv, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
      [userId, accountId, cardNumber, cardType || 'debit', cardProvider || 'Mastercard', expiryStr, cvv]
    );
    await ledger.logAudit(req.user.id, userId, 'issue_card', 'cards', result.insertId);
    return res.json({ success: true, message: 'Card issued.', cardNumber });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/cards/:id/approve', async (req, res) => {
  try {
    await db.query("UPDATE cards SET status = 'active' WHERE id = ?", [req.params.id]);
    await ledger.logAudit(req.user.id, null, 'approve_card', 'cards', req.params.id);
    return res.json({ success: true, message: 'Card approved and activated.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/cards/:id/block', async (req, res) => {
  await db.query("UPDATE cards SET status = 'blocked' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, null, 'block_card', 'cards', req.params.id);
  return res.json({ success: true, message: 'Card blocked.' });
});

router.post('/cards/:id/unblock', async (req, res) => {
  await db.query("UPDATE cards SET status = 'active' WHERE id = ?", [req.params.id]);
  await ledger.logAudit(req.user.id, null, 'unblock_card', 'cards', req.params.id);
  return res.json({ success: true, message: 'Card unblocked.' });
});

// ════════════════════════════════════════════════════════════
// SUPPORT & NOTIFICATIONS
// ════════════════════════════════════════════════════════════

router.get('/tickets', async (req, res) => {
  try {
    const [tickets] = await db.query(
      `SELECT t.*, u.full_name AS user_name, a.full_name AS assigned_name
       FROM tickets t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN users a ON t.assigned_to = a.id
       ORDER BY t.created_at DESC`
    );
    return res.json({ success: true, tickets });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/tickets/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ success: false, message: 'Reply body required.' });
  try {
    await db.query(
      "INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, body) VALUES (?, ?, 'admin', ?)",
      [req.params.id, req.user.id, body]
    );
    await db.query("UPDATE tickets SET status = 'pending' WHERE id = ?", [req.params.id]);
    return res.json({ success: true, message: 'Reply sent.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/tickets/:id/assign', async (req, res) => {
  const { adminId } = req.body;
  await db.query('UPDATE tickets SET assigned_to = ? WHERE id = ?', [adminId, req.params.id]);
  return res.json({ success: true, message: 'Ticket assigned.' });
});

router.post('/broadcast', async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ success: false, message: 'Title and body required.' });
  try {
    const [users] = await db.query("SELECT id FROM users WHERE role = 'customer' AND status = 'active'");
    for (const u of users) {
      await db.query('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)', [u.id, title, body]);
    }
    await ledger.logAudit(req.user.id, null, 'broadcast_msg', 'notifications', null);
    return res.json({ success: true, message: `Broadcast sent to ${users.length} users.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const [notifications] = await db.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100');
    return res.json({ success: true, notifications });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/notifications', async (req, res) => {
  const { userId, title, body } = req.body;
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)', [userId || null, title, body]);
  return res.json({ success: true, message: 'Notification sent.' });
});

// ════════════════════════════════════════════════════════════
// BILLS & GOALS (admin view)
// ════════════════════════════════════════════════════════════

router.get('/bills', async (req, res) => {
  try {
    const [bills] = await db.query('SELECT b.*, u.full_name FROM bills b JOIN users u ON b.user_id = u.id ORDER BY b.due_date DESC');
    return res.json({ success: true, bills });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bills', async (req, res) => {
  const { userId, accountId, billName, merchantName, amount, dueDate } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO bills (user_id, account_id, bill_name, merchant_name, amount, due_date) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, accountId || null, billName, merchantName || null, amount, dueDate]
    );
    return res.json({ success: true, message: 'Bill created.', billId: result.insertId });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/goals', async (req, res) => {
  try {
    const [goals] = await db.query('SELECT g.*, u.full_name FROM savings_goals g JOIN users u ON g.user_id = u.id ORDER BY g.id DESC');
    return res.json({ success: true, goals });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// AUDIT LOGS
// ════════════════════════════════════════════════════════════

router.get('/audit-logs', async (req, res) => {
  const { risk_level } = req.query;
  try {
    let sql = 'SELECT l.*, u.full_name AS admin_name FROM audit_logs l LEFT JOIN users u ON l.admin_id = u.id';
    const params = [];
    if (risk_level) {
      sql += ' WHERE l.risk_level = ?';
      params.push(risk_level);
    }
    sql += ' ORDER BY l.created_at DESC LIMIT 500';
    const [logs] = await db.query(sql, params);
    return res.json({ success: true, logs });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════

router.get('/reports/financial', async (req, res) => {
  const { from, to } = req.query;
  try {
    const conditions = [], params = [];
    if (from) { conditions.push('t.created_at >= ?'); params.push(from); }
    if (to)   { conditions.push('t.created_at <= ?'); params.push(to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [totals] = await db.query(
      `SELECT
        SUM(CASE WHEN transaction_type IN ('deposit','admin_credit') THEN amount ELSE 0 END) AS total_deposits,
        SUM(CASE WHEN transaction_type IN ('withdrawal','admin_debit') THEN amount ELSE 0 END) AS total_withdrawals,
        SUM(CASE WHEN transaction_type = 'transfer' THEN amount ELSE 0 END) AS total_transfers,
        SUM(fee) AS total_fees,
        COUNT(*) AS transaction_count,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count
       FROM internal_transactions t ${where}`, params
    );

    const [byType] = await db.query(
      `SELECT transaction_type, COUNT(*) AS count, SUM(amount) AS volume
       FROM internal_transactions t ${where} GROUP BY transaction_type`, params
    );

    const [accountTotals] = await db.query(
      "SELECT SUM(balance) AS total_aum, COUNT(*) AS total_accounts, AVG(balance) AS avg_balance FROM internal_accounts WHERE status = 'active'"
    );

    return res.json({ success: true, period: { from: from || null, to: to || null }, totals: totals[0], byType, accountTotals: accountTotals[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reports/transactions', async (req, res) => {
  try {
    const [transactions] = await db.query(
      `SELECT t.*, fa.account_number AS from_account_number, ta.account_number AS to_account_number
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id
       ORDER BY t.created_at DESC LIMIT 500`
    );
    return res.json({ success: true, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reports/users', async (req, res) => {
  try {
    const [summary] = await db.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_users,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_users,
        COUNT(CASE WHEN status = 'suspended' THEN 1 END) AS suspended_users,
        COUNT(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 END) AS new_last_30d
       FROM users WHERE role = 'customer'`
    );
    return res.json({ success: true, report: summary[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// CSV export
router.get('/reports/export', async (req, res) => {
  const { format } = req.query;

  if (format === 'pdf') {
    return res.status(501).json({ success: false, message: 'PDF export is not implemented. Use format=csv.' });
  }

  if (format !== 'csv') {
    return res.status(400).json({ success: false, message: 'Supported formats: csv, pdf (not implemented).' });
  }

  try {
    const [transactions] = await db.query(
      `SELECT t.transaction_ref, t.amount, t.fee, t.total_amount, t.transaction_type, t.category,
              t.status, t.description, t.created_at,
              fa.account_number AS from_account, ta.account_number AS to_account
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id
       ORDER BY t.created_at DESC LIMIT 5000`
    );

    // Build CSV manually (no external dep needed)
    const headers = ['Ref', 'Amount', 'Fee', 'Total', 'Type', 'Category', 'Status', 'Description', 'From', 'To', 'Date'];
    const csvRows = [headers.join(',')];
    for (const t of transactions) {
      csvRows.push([
        t.transaction_ref,
        t.amount,
        t.fee,
        t.total_amount,
        t.transaction_type,
        `"${(t.category || '').replace(/"/g, '""')}"`,
        t.status,
        `"${(t.description || '').replace(/"/g, '""')}"`,
        t.from_account || '',
        t.to_account || '',
        t.created_at ? new Date(t.created_at).toISOString() : '',
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_export_${Date.now()}.csv`);
    return res.send(csvRows.join('\n'));
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// SYSTEM — SUPER ADMIN ONLY
// ════════════════════════════════════════════════════════════

// Settings
router.get('/system/settings', requireSuperAdmin, async (req, res) => {
  try {
    const [settings] = await db.query('SELECT * FROM system_settings ORDER BY category, key_name');
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/system/settings', requireSuperAdmin, async (req, res) => {
  const { settings } = req.body;
  if (!Array.isArray(settings)) return res.status(400).json({ success: false, message: 'settings must be an array.' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const s of settings) {
      await conn.query(
        'INSERT INTO system_settings (key_name, key_value, category) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)',
        [s.key_name, String(s.key_value), s.category || 'general']
      );
      await ledger.logAudit(req.user.id, null, 'settings_update', 'system_settings', null, null, { key_name: s.key_name, key_value: s.key_value }, conn);
    }
    await conn.commit();
    return res.json({ success: true, message: `${settings.length} setting(s) updated.` });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// Admin management
router.get('/system/admins', requireSuperAdmin, async (req, res) => {
  const [admins] = await db.query("SELECT id, full_name, email, role, status, last_login FROM users WHERE role != 'customer'");
  return res.json({ success: true, admins });
});

router.post('/system/admins', requireSuperAdmin, async (req, res) => {
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email) return res.status(400).json({ success: false, message: 'Name and email required.' });
  const hash = await bcrypt.hash(password || 'Admin@12345', 10);
  await db.query(
    "INSERT INTO users (full_name, email, password, role, status, email_verified_at) VALUES (?, ?, ?, ?, 'active', NOW())",
    [full_name, email, hash, role || 'admin']
  );
  return res.json({ success: true, message: 'Admin created.' });
});

router.put('/system/admins/:id', requireSuperAdmin, async (req, res) => {
  const { full_name, email, role, status } = req.body;
  await db.query(
    'UPDATE users SET full_name = ?, email = ?, role = ?, status = ? WHERE id = ?',
    [full_name, email, role, status, req.params.id]
  );
  return res.json({ success: true, message: 'Admin updated.' });
});

// Backup
router.post('/system/backup', requireSuperAdmin, async (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename  = `backup_${timestamp}.sql`;
  const filepath  = path.join(BACKUP_DIR, filename);

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const args = [
    `--host=${DB_HOST || 'localhost'}`,
    `--port=${DB_PORT || '3306'}`,
    `--user=${DB_USER || 'root'}`,
    DB_PASSWORD ? `--password=${DB_PASSWORD}` : '--skip-lock-tables',
    '--single-transaction', '--routines', '--triggers',
    DB_NAME || 'olith_banking',
  ];

  try {
    await new Promise((resolve, reject) => {
      execFile('mysqldump', args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`mysqldump failed: ${stderr || err.message}`));
        fs.writeFileSync(filepath, stdout);
        resolve();
      });
    });

    // Generate HMAC manifest
    const fileContent = fs.readFileSync(filepath);
    const hmac = nodeCrypto.createHmac('sha256', JWT_SECRET());
    hmac.update(fileContent);
    const signature = hmac.digest('hex');

    const manifest = { filename, timestamp, signature, generatedBy: req.user.id };
    fs.writeFileSync(filepath + '.manifest.json', JSON.stringify(manifest, null, 2));

    await ledger.logAudit(req.user.id, null, 'backup_db', 'system', null, null, { filename });
    return res.json({ success: true, message: 'Backup created.', filename });
  } catch (err) {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Restore
router.post('/system/restore', requireSuperAdmin, async (req, res) => {
  const { confirmed, filename } = req.body;
  if (!confirmed) return res.status(400).json({ success: false, message: 'Confirmation flag required.' });
  if (!filename)  return res.status(400).json({ success: false, message: 'Filename required.' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename.' });
  }

  const filepath     = path.join(BACKUP_DIR, filename);
  const manifestPath = filepath + '.manifest.json';

  if (!fs.existsSync(filepath) || !fs.existsSync(manifestPath)) {
    return res.status(404).json({ success: false, message: 'Backup or manifest not found.' });
  }

  // Verify HMAC
  const manifest    = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fileContent = fs.readFileSync(filepath);
  const hmac        = nodeCrypto.createHmac('sha256', JWT_SECRET());
  hmac.update(fileContent);
  const computedSig = hmac.digest('hex');

  if (computedSig !== manifest.signature) {
    await ledger.logAudit(req.user.id, null, 'restore_db_tamper_detected', 'system', null, null, { filename });
    return res.status(403).json({ success: false, message: 'Backup integrity check failed — signature mismatch.' });
  }

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const args = [
    `--host=${DB_HOST || 'localhost'}`,
    `--port=${DB_PORT || '3306'}`,
    `--user=${DB_USER || 'root'}`,
    DB_PASSWORD ? `--password=${DB_PASSWORD}` : '',
    DB_NAME || 'olith_banking',
  ].filter(Boolean);

  try {
    await new Promise((resolve, reject) => {
      const child = execFile('mysql', args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`mysql restore failed: ${stderr || err.message}`));
        resolve();
      });
      child.stdin.write(fileContent);
      child.stdin.end();
    });

    await ledger.logAudit(req.user.id, null, 'restore_db', 'system', null, null, { filename });
    return res.json({ success: true, message: `Database restored from ${filename}.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
