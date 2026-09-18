/**
 * routes/bank.js
 * Stripe Financial Connections: create session, complete session, institutions, transactions, disconnect, webhook.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { requireAuth } = require('../middlewares/auth');
const { plaidLinkRateLimiter } = require('../middlewares/rateLimit');
const { verifyStripeWebhook } = require('../middlewares/stripeWebhook');
const stripe = require('../services/stripeClient');

// Re-use the existing rate limiter but we can mentally call it bankLinkRateLimiter
const bankLinkRateLimiter = plaidLinkRateLimiter;

// Helper to map institution ID or name to a color
const INSTITUTION_COLORS = {
  'chase':  '#0f6fb0', 
  'bofa':  '#c11c1c', 
  'wells_fargo':  '#d21e2b', 
  'capital_one':  '#004977', 
  'usaa':  '#1a1a2e', 
  'td':  '#00693e', 
  'citi':  '#b22234', 
  'us_bank': '#003087', 
};

function getInstitutionColor(name) {
  if (!name) return '#4a5451';
  const n = name.toLowerCase();
  for (const [key, color] of Object.entries(INSTITUTION_COLORS)) {
    if (n.includes(key.replace('_', ' '))) return color;
  }
  return '#4a5451';
}

// ─── POST /api/bank/create_session ─────────────────────────────────────
router.post('/create_session', requireAuth, bankLinkRateLimiter, async (req, res) => {
  try {
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.full_name,
      });
      customerId = customer.id;
      await db.query('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, req.user.id]);
    }

    const session = await stripe.financialConnections.sessions.create({
      account_holder: { type: 'customer', customer: customerId },
      permissions: ['balances', 'transactions'],
    });

    return res.json({ success: true, client_secret: session.client_secret });
  } catch (err) {
    console.error('Stripe create_session error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create connection session.' });
  }
});

// ─── POST /api/bank/session_complete ───────────────────────────────────
router.post('/session_complete', requireAuth, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ success: false, message: 'Missing session_id.' });
  }

  try {
    const session = await stripe.financialConnections.sessions.retrieve(session_id, {
      expand: ['accounts']
    });

    if (!session.accounts || session.accounts.data.length === 0) {
      return res.status(400).json({ success: false, message: 'No accounts connected.' });
    }

    // Create the connection row
    const [connResult] = await db.query(
      `INSERT INTO bank_connections (user_id, stripe_session_id, status) VALUES (?, ?, 'active')`,
      [req.user.id, session.id]
    );
    const bankConnectionId = connResult.insertId;

    for (const account of session.accounts.data) {
      // Subscribe to ongoing updates
      try {
        await stripe.financialConnections.accounts.subscribe(account.id, {
          features: ['balance', 'transactions']
        });
      } catch (subErr) {
        console.warn(`[STRIPE] Could not subscribe to account ${account.id}:`, subErr.message);
      }

      const bal = account.balance ? (account.balance.current[account.currency] / 100) : 0;
      
      await db.query(
        `INSERT INTO bank_connection_accounts (
           bank_connection_id, stripe_account_id, institution_name, display_name, last4, category,
           balance_current, balance_available, currency, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE status='active', balance_current=VALUES(balance_current)`,
        [
          bankConnectionId,
          account.id,
          account.institution_name,
          account.display_name,
          account.last4,
          account.subcategory,
          bal,
          bal, // using current as available for simplicity if not provided
          account.currency || 'USD'
        ]
      );
    }

    return res.json({ success: true, message: 'Bank connected successfully.' });
  } catch (err) {
    console.error('Stripe session_complete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to complete connection.' });
  }
});

// ─── GET /api/bank/config ──────────────────────────────────────────────
router.get('/config', (req, res) => {
  return res.json({ publishable_key: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ─── GET /api/bank/institutions ────────────────────────────────────────
router.get('/institutions', requireAuth, async (req, res) => {
  try {
    // Group accounts by institution name to mimic Plaid items
    const [accounts] = await db.query(
      `SELECT a.*, c.status AS connection_status 
       FROM bank_connection_accounts a
       JOIN bank_connections c ON a.bank_connection_id = c.id
       WHERE c.user_id = ? AND a.status = 'active'`,
      [req.user.id]
    );

    const grouped = {};
    for (const acc of accounts) {
      const instName = acc.institution_name || 'Bank';
      if (!grouped[instName]) {
        grouped[instName] = {
          id: acc.id, // using first account ID as a proxy for the institution group to disconnect
          name: instName,
          color: getInstitutionColor(instName),
          accounts: 0,
          balance: 0,
          status: acc.status
        };
      }
      grouped[instName].accounts += 1;
      grouped[instName].balance += parseFloat(acc.balance_current || 0);
    }

    const institutions = Object.values(grouped);
    return res.json({ success: true, institutions });
  } catch (err) {
    console.error('Fetch institutions error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── GET /api/bank/institutions/:accountId/transactions ────────────────
router.get('/institutions/:accountId/transactions', requireAuth, async (req, res) => {
  // :accountId here is actually the ID from the grouped institutions response, which is our internal account ID.
  try {
    const [accs] = await db.query(
      `SELECT a.*, c.user_id 
       FROM bank_connection_accounts a 
       JOIN bank_connections c ON a.bank_connection_id = c.id 
       WHERE a.id = ? AND c.user_id = ?`,
      [req.params.accountId, req.user.id]
    );

    if (accs.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const localAcc = accs[0];
    
    // Trigger refresh (fire and forget / await)
    try {
      await stripe.financialConnections.accounts.refresh(localAcc.stripe_account_id, {
        features: ['transactions']
      });
      // In a real app we might poll. Here we just fetch what's available now.
    } catch(err) {
      console.warn(`[STRIPE] Refresh failed for ${localAcc.stripe_account_id}`, err.message);
    }

    // Fetch transactions from Stripe
    const txRes = await stripe.financialConnections.transactions.list({
      account: localAcc.stripe_account_id,
      limit: 100
    });

    for (const txn of txRes.data) {
      await db.query(
        `INSERT IGNORE INTO bank_transactions (
           bank_connection_account_id, stripe_transaction_id, amount, currency, description, category, status, transacted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localAcc.id,
          txn.id,
          txn.amount / 100, // Stripe amount is in cents
          txn.currency,
          txn.description,
          txn.subcategory || 'Other',
          txn.status,
          new Date(txn.transacted_at * 1000).toISOString().split('T')[0]
        ]
      );
    }

    // Return the updated list from local DB
    const [transactions] = await db.query(
      `SELECT * FROM bank_transactions WHERE bank_connection_account_id = ? ORDER BY transacted_at DESC`,
      [localAcc.id]
    );

    return res.json({
      success: true,
      institutionName: localAcc.institution_name,
      transactions: transactions.map(t => ({
        id:       t.id,
        name:     t.description,
        amount:   parseFloat(t.amount),
        category: t.category,
        date:     new Date(t.transacted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        pending:  t.status === 'pending',
      })),
    });
  } catch (err) {
    console.error('Fetch transactions error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── DELETE /api/bank/institutions/:accountId ──────────────────────────
router.delete('/institutions/:accountId', requireAuth, async (req, res) => {
  try {
    const [accs] = await db.query(
      `SELECT a.*, c.user_id 
       FROM bank_connection_accounts a 
       JOIN bank_connections c ON a.bank_connection_id = c.id 
       WHERE a.id = ? AND c.user_id = ?`,
      [req.params.accountId, req.user.id]
    );

    if (accs.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const localAcc = accs[0];

    try {
      await stripe.financialConnections.accounts.disconnect(localAcc.stripe_account_id);
    } catch(err) {
      console.warn(`[STRIPE] Disconnect API failed for ${localAcc.stripe_account_id}`, err.message);
    }

    await db.query('DELETE FROM bank_connection_accounts WHERE id = ?', [localAcc.id]);
    
    // Check if session has any other accounts
    const [remaining] = await db.query('SELECT COUNT(*) as count FROM bank_connection_accounts WHERE bank_connection_id = ?', [localAcc.bank_connection_id]);
    if (remaining[0].count === 0) {
      await db.query('UPDATE bank_connections SET status = "disconnected" WHERE id = ?', [localAcc.bank_connection_id]);
    }

    return res.json({ success: true, message: 'Bank disconnected.' });
  } catch (err) {
    console.error('Disconnect bank error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── POST /api/bank/webhook ────────────────────────────────────────────
// This will be mounted manually in app.js with express.raw
router.webhookHandler = async (req, res) => {
  let event = req.stripeEvent; // Populated by verifyStripeWebhook
  
  if (!event) {
    return res.status(400).send('Webhook error: event missing');
  }

  console.log(`[STRIPE WEBHOOK] Received event: ${event.type}`);

  if (event.type === 'financial_connections.account.refreshed_balance') {
    const account = event.data.object;
    if (account.balance) {
      const bal = account.balance.current[account.currency] / 100;
      await db.query('UPDATE bank_connection_accounts SET balance_current = ? WHERE stripe_account_id = ?', [bal, account.id]);
    }
  } else if (event.type === 'financial_connections.account.refreshed_transactions') {
    const account = event.data.object;
    // We could fetch transactions here similar to the route, but the route already triggers on demand.
    // For completeness, we can just leave it as a log. Real app might async pull them.
    console.log(`[STRIPE WEBHOOK] Transactions refreshed for ${account.id}`);
  } else if (event.type === 'financial_connections.account.disconnected') {
    const account = event.data.object;
    await db.query('UPDATE bank_connection_accounts SET status = "inactive" WHERE stripe_account_id = ?', [account.id]);
  }

  return res.json({ received: true });
};

module.exports = router;
