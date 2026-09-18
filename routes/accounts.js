/**
 * routes/accounts.js
 * Customer-facing: accounts, cards, transfers, goals, bills, tickets.
 * Exports main router + sub-routers for /api/goals, /api/bills, /api/tickets.
 */

const express = require('express');
const router  = express.Router();
const goalsRouter   = express.Router();
const billsRouter   = express.Router();
const ticketsRouter = express.Router();

const db     = require('../config/db');
const ledger = require('../services/ledger');
const { requireAuth } = require('../middlewares/auth');

// All routes require auth
router.use(requireAuth);
goalsRouter.use(requireAuth);
billsRouter.use(requireAuth);
ticketsRouter.use(requireAuth);

// ════════════════════════════════════════════════════════════
// ACCOUNTS
// ════════════════════════════════════════════════════════════

// GET /api/accounts — user's internal accounts + balances
router.get('/', async (req, res) => {
  try {
    const [accounts] = await db.query(
      'SELECT id, account_number, account_name, account_type, balance, overdraft_limit, status FROM internal_accounts WHERE user_id = ?',
      [req.user.id]
    );
    const [transactions] = await db.query(
      `SELECT t.*, fa.account_number AS from_account, ta.account_number AS to_account
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id
       WHERE fa.user_id = ? OR ta.user_id = ?
       ORDER BY t.created_at DESC LIMIT 20`,
      [req.user.id, req.user.id]
    );
    return res.json({ success: true, accounts, transactions });
  } catch (err) {
    console.error('GET /api/accounts error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/accounts/summary — combined net worth
router.get('/summary', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT COALESCE(SUM(balance), 0) AS net_worth,
              COUNT(*) AS account_count
       FROM internal_accounts
       WHERE user_id = ? AND account_type IN ('checking','savings','vault') AND status = 'active'`,
      [req.user.id]
    );
    return res.json({ success: true, netWorth: parseFloat(rows[0].net_worth), accountCount: rows[0].account_count });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/accounts/cards — user's cards
router.get('/cards', async (req, res) => {
  try {
    const [cards] = await db.query(
      `SELECT c.id, c.card_number, c.card_type, c.card_provider, c.expiry_date, c.status,
              a.balance, a.account_type, a.account_number
       FROM cards c
       JOIN internal_accounts a ON c.account_id = a.id
       WHERE c.user_id = ? AND c.status != 'inactive'`,
      [req.user.id]
    );
    return res.json({ success: true, cards });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/accounts/cards/request — customer requests a new card
router.post('/cards/request', async (req, res) => {
  const { account_id, card_type } = req.body;

  try {
    // Verify account ownership
    const [accs] = await db.query(
      'SELECT id FROM internal_accounts WHERE id = ? AND user_id = ? AND status = "active"',
      [account_id || 0, req.user.id]
    );

    let targetAccountId;
    if (accs.length > 0) {
      targetAccountId = accs[0].id;
    } else {
      // Use first active account
      const [defaultAccs] = await db.query(
        'SELECT id FROM internal_accounts WHERE user_id = ? AND status = "active" LIMIT 1',
        [req.user.id]
      );
      if (defaultAccs.length === 0) {
        return res.status(400).json({ success: false, message: 'No active account found.' });
      }
      targetAccountId = defaultAccs[0].id;
    }

    // Generate card details
    const cardNumber = '5412' + Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const cvv = Math.floor(100 + Math.random() * 900).toString();
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 4);
    const expiryStr = String(expiry.getMonth() + 1).padStart(2, '0') + '/' + String(expiry.getFullYear()).slice(-2);

    await db.query(
      `INSERT INTO cards (user_id, account_id, card_number, card_type, card_provider, expiry_date, cvv, status)
       VALUES (?, ?, ?, ?, 'Mastercard', ?, ?, 'pending')`,
      [req.user.id, targetAccountId, cardNumber, card_type || 'debit', expiryStr, cvv]
    );

    return res.json({ success: true, message: 'Card request submitted. Pending admin approval.' });
  } catch (err) {
    console.error('Card request error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/accounts/transfers — internal transfer
router.post('/transfers', async (req, res) => {
  const { to_account_number, amount, category, description } = req.body;
  const amt = parseFloat(amount);

  if (!to_account_number || !amt || amt <= 0) {
    return res.status(400).json({ success: false, message: 'Valid recipient account number and amount are required.' });
  }

  try {
    // Get sender's primary account
    const [fromAccs] = await db.query(
      'SELECT id FROM internal_accounts WHERE user_id = ? AND status = "active" ORDER BY account_type = "checking" DESC LIMIT 1',
      [req.user.id]
    );
    if (fromAccs.length === 0) {
      return res.status(400).json({ success: false, message: 'No active account to send from.' });
    }

    // Find destination account
    const [toAccs] = await db.query(
      'SELECT id FROM internal_accounts WHERE account_number = ? AND status = "active"',
      [to_account_number]
    );
    if (toAccs.length === 0) {
      return res.status(400).json({ success: false, message: 'Destination account not found or inactive.' });
    }

    if (fromAccs[0].id === toAccs[0].id) {
      return res.status(400).json({ success: false, message: 'Cannot transfer to the same account.' });
    }

    const result = await ledger.transferFunds(
      fromAccs[0].id,
      toAccs[0].id,
      amt,
      0,
      category || 'Transfer',
      description || 'Internal Transfer',
      null,
      req.user.id
    );

    return res.json({
      success: true,
      message: 'Transfer completed.',
      transactionRef: result.transactionRef,
      fromNewBalance: result.fromNewBalance,
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(400).json({ success: false, message: err.message || 'Transfer failed.' });
  }
});

// GET /api/accounts/transactions/:id — transaction detail (ownership verified)
router.get('/transactions/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*
       FROM internal_transactions t
       LEFT JOIN internal_accounts fa ON t.from_account_id = fa.id
       LEFT JOIN internal_accounts ta ON t.to_account_id = ta.id
       WHERE t.id = ? AND (fa.user_id = ? OR ta.user_id = ?)`,
      [req.params.id, req.user.id, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }
    return res.json({ success: true, transaction: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
// SAVINGS GOALS / STACKING VAULTS
// ════════════════════════════════════════════════════════════

// GET /api/goals
goalsRouter.get('/', async (req, res) => {
  try {
    const [goals] = await db.query(
      'SELECT g.*, a.balance AS vault_balance FROM savings_goals g LEFT JOIN internal_accounts a ON g.vault_account_id = a.id WHERE g.user_id = ? ORDER BY g.id DESC',
      [req.user.id]
    );
    return res.json({ success: true, goals });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/goals — create a new goal
goalsRouter.post('/', async (req, res) => {
  const { goal_name, target_amount, target_date } = req.body;
  if (!goal_name || !target_amount || !target_date) {
    return res.status(400).json({ success: false, message: 'goal_name, target_amount, and target_date are required.' });
  }

  try {
    // Create a vault account for the goal
    const accountNumber = 'VLT' + Math.floor(1000000000000 + Math.random() * 9000000000000);
    const [accResult] = await db.query(
      "INSERT INTO internal_accounts (user_id, account_number, account_name, account_type, balance, status) VALUES (?, ?, ?, 'vault', 0.00, 'active')",
      [req.user.id, accountNumber, `Vault: ${goal_name}`]
    );

    const [goalResult] = await db.query(
      'INSERT INTO savings_goals (user_id, vault_account_id, goal_name, target_amount, target_date) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, accResult.insertId, goal_name, target_amount, target_date]
    );

    return res.json({ success: true, message: 'Goal created.', goalId: goalResult.insertId, vaultAccountNumber: accountNumber });
  } catch (err) {
    console.error('Create goal error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/goals/:id/contribute — manually move money into vault
goalsRouter.post('/:id/contribute', async (req, res) => {
  const { from_account_id, amount } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount required.' });
  }

  try {
    const [goals] = await db.query('SELECT * FROM savings_goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (goals.length === 0) return res.status(404).json({ success: false, message: 'Goal not found.' });

    const goal = goals[0];
    if (!goal.vault_account_id) return res.status(400).json({ success: false, message: 'Goal has no linked vault account.' });

    // Determine source account
    let sourceId = from_account_id;
    if (!sourceId) {
      const [accs] = await db.query(
        "SELECT id FROM internal_accounts WHERE user_id = ? AND account_type = 'checking' AND status = 'active' LIMIT 1",
        [req.user.id]
      );
      if (accs.length === 0) return res.status(400).json({ success: false, message: 'No active checking account.' });
      sourceId = accs[0].id;
    }

    const result = await ledger.transferFunds(
      sourceId,
      goal.vault_account_id,
      amt,
      0,
      'Savings',
      `Contribution to ${goal.goal_name}`,
      null,
      req.user.id
    );

    // Update goal current_amount
    await db.query(
      'UPDATE savings_goals SET current_amount = current_amount + ? WHERE id = ?',
      [amt, goal.id]
    );

    // Check if goal is completed
    const newAmount = parseFloat(goal.current_amount) + amt;
    if (newAmount >= parseFloat(goal.target_amount)) {
      await db.query("UPDATE savings_goals SET status = 'completed' WHERE id = ?", [goal.id]);
    }

    return res.json({ success: true, message: 'Contribution successful.', transactionRef: result.transactionRef });
  } catch (err) {
    console.error('Goal contribute error:', err);
    return res.status(400).json({ success: false, message: err.message || 'Contribution failed.' });
  }
});

// POST /api/goals/:id/auto — toggle automatic contributions
goalsRouter.post('/:id/auto', async (req, res) => {
  const { auto_enabled, auto_amount, auto_frequency } = req.body;

  try {
    const [goals] = await db.query('SELECT * FROM savings_goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (goals.length === 0) return res.status(404).json({ success: false, message: 'Goal not found.' });

    await db.query(
      'UPDATE savings_goals SET auto_enabled = ?, auto_amount = ?, auto_frequency = ? WHERE id = ?',
      [auto_enabled ? 1 : 0, auto_amount || null, auto_frequency || null, req.params.id]
    );

    return res.json({
      success: true,
      message: auto_enabled ? 'Auto-contribution enabled.' : 'Auto-contribution disabled.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
// BILLS
// ════════════════════════════════════════════════════════════

// GET /api/bills
billsRouter.get('/', async (req, res) => {
  try {
    const [bills] = await db.query('SELECT * FROM bills WHERE user_id = ? ORDER BY due_date ASC', [req.user.id]);
    return res.json({ success: true, bills });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/bills/:id/pay — pay a bill
billsRouter.post('/:id/pay', async (req, res) => {
  const { account_id } = req.body;

  try {
    const [bills] = await db.query('SELECT * FROM bills WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (bills.length === 0) return res.status(404).json({ success: false, message: 'Bill not found.' });

    const bill = bills[0];
    if (bill.status === 'paid') return res.status(400).json({ success: false, message: 'Bill is already paid.' });

    // Determine source account
    let sourceId = account_id || bill.account_id;
    if (!sourceId) {
      const [accs] = await db.query(
        "SELECT id FROM internal_accounts WHERE user_id = ? AND account_type = 'checking' AND status = 'active' LIMIT 1",
        [req.user.id]
      );
      if (accs.length === 0) return res.status(400).json({ success: false, message: 'No active account.' });
      sourceId = accs[0].id;
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      await ledger.mutateBalance(
        sourceId,
        parseFloat(bill.amount),
        'debit',
        'Bills',
        `Bill payment: ${bill.bill_name}`,
        'bill_payment',
        conn
      );

      await conn.query("UPDATE bills SET status = 'paid' WHERE id = ?", [bill.id]);
      await conn.commit();

      return res.json({ success: true, message: 'Bill paid successfully.' });
    } catch (err) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: err.message || 'Bill payment failed.' });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Bill pay error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ════════════════════════════════════════════════════════════

// GET /api/tickets
ticketsRouter.get('/', async (req, res) => {
  try {
    const [tickets] = await db.query('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    return res.json({ success: true, tickets });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/tickets — create ticket + initial message
ticketsRouter.post('/', async (req, res) => {
  const { subject, body } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ success: false, message: 'Subject and message are required.' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO tickets (user_id, subject) VALUES (?, ?)',
      [req.user.id, subject]
    );
    await db.query(
      "INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, body) VALUES (?, ?, 'user', ?)",
      [result.insertId, req.user.id, body]
    );
    return res.json({ success: true, message: 'Ticket created.', ticketId: result.insertId });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/tickets/:id — ticket + thread (ownership verified)
ticketsRouter.get('/:id', async (req, res) => {
  try {
    const [tickets] = await db.query('SELECT * FROM tickets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    const [messages] = await db.query(
      `SELECT m.*, u.full_name AS sender_name
       FROM ticket_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.ticket_id = ?
       ORDER BY m.created_at ASC`,
      [req.params.id]
    );

    return res.json({ success: true, ticket: tickets[0], messages });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/tickets/:id/reply — customer reply to own ticket
ticketsRouter.post('/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ success: false, message: 'Message body is required.' });

  try {
    const [tickets] = await db.query('SELECT * FROM tickets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    await db.query(
      "INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, body) VALUES (?, ?, 'user', ?)",
      [req.params.id, req.user.id, body]
    );
    await db.query("UPDATE tickets SET status = 'open' WHERE id = ?", [req.params.id]);

    return res.json({ success: true, message: 'Reply sent.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Export main router + sub-routers
router.goalsRouter   = goalsRouter;
router.billsRouter   = billsRouter;
router.ticketsRouter = ticketsRouter;

module.exports = router;
