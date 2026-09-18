/**
 * services/ledger.js
 * Single source of truth for every balance mutation in the system.
 *
 * ALL money movement flows through this module — deposits, withdrawals,
 * transfers, payments, admin credits/debits. No ad-hoc balance updates
 * anywhere else in the codebase.
 */

const crypto = require('crypto');
const db = require('../config/db');

// ─── Risk level mapping for audit log entries ───
const HIGH_RISK_ACTIONS = new Set([
  'add_funds', 'restore_db', 'suspend_user', 'close_user',
]);
const MEDIUM_RISK_ACTIONS = new Set([
  'freeze_account', 'unfreeze_account', 'block_card', 'unblock_card',
  'approve_txn', 'reject_txn',
]);

function computeRiskLevel(action) {
  if (HIGH_RISK_ACTIONS.has(action))   return 'high';
  if (MEDIUM_RISK_ACTIONS.has(action)) return 'medium';
  return 'low';
}

/**
 * mutateBalance — the atomic primitive for every balance change.
 *
 * Locks the account row (SELECT … FOR UPDATE), validates status and
 * overdraft, updates the balance, and writes an internal_transactions row.
 *
 * @param {number}  accountId       - internal_accounts.id
 * @param {number}  amount          - positive for credit, negative for debit
 * @param {string}  type            - 'credit' | 'debit'
 * @param {string}  category        - e.g. 'Transfer', 'Salary', 'Bills'
 * @param {string}  description     - human-readable note
 * @param {string}  transactionType - maps to internal_transactions.transaction_type enum
 * @param {object}  connection      - a mysql2 PoolConnection (caller manages BEGIN/COMMIT)
 * @returns {{ newBalance: number, transactionRef: string }}
 */
async function mutateBalance(accountId, amount, type, category, description, transactionType, connection) {
  const conn = connection || await db.getConnection();
  const isOwnConnection = !connection;
  try {
    if (isOwnConnection) await conn.beginTransaction();

    // Lock row
    const [rows] = await conn.query(
      'SELECT id, balance, overdraft_limit, status FROM internal_accounts WHERE id = ? FOR UPDATE',
      [accountId]
    );
    if (rows.length === 0) throw new Error('Account not found.');
    const account = rows[0];

    if (account.status === 'frozen') throw new Error('Account is frozen.');
    if (account.status === 'closed') throw new Error('Account is closed.');

    const currentBalance = parseFloat(account.balance);
    const delta           = parseFloat(amount);
    const overdraftLimit  = parseFloat(account.overdraft_limit || 0);

    // For debits, check sufficient funds (balance + overdraft)
    if (type === 'debit' && delta > 0) {
      // debit amount is expressed as positive, we subtract
      if (currentBalance + overdraftLimit < delta) {
        throw new Error(`Insufficient funds. Available: $${(currentBalance + overdraftLimit).toFixed(2)}`);
      }
    }

    // Compute new balance
    let newBalance;
    if (type === 'credit') {
      newBalance = currentBalance + Math.abs(delta);
    } else {
      newBalance = currentBalance - Math.abs(delta);
    }

    // Update balance
    await conn.query(
      'UPDATE internal_accounts SET balance = ? WHERE id = ?',
      [newBalance.toFixed(2), accountId]
    );

    // Write transaction row
    const transactionRef = 'TXN-' + crypto.randomUUID().split('-')[0].toUpperCase();
    const totalAmount    = Math.abs(delta);

    await conn.query(
      `INSERT INTO internal_transactions
        (transaction_ref, from_account_id, to_account_id, amount, fee, total_amount,
         transaction_type, category, status, description, completed_at, created_at)
       VALUES (?, ?, ?, ?, 0.00, ?, ?, ?, 'completed', ?, NOW(), NOW())`,
      [
        transactionRef,
        type === 'debit'  ? accountId : null,
        type === 'credit' ? accountId : null,
        totalAmount.toFixed(2),
        totalAmount.toFixed(2),
        transactionType,
        category,
        description,
      ]
    );

    if (isOwnConnection) await conn.commit();
    return { newBalance, transactionRef };
  } catch (err) {
    if (isOwnConnection) await conn.rollback();
    throw err;
  } finally {
    if (isOwnConnection) conn.release();
  }
}

/**
 * transferFunds — atomic transfer between two internal accounts.
 *
 * Wraps two mutateBalance calls (debit sender, credit receiver) inside a
 * single DB transaction — both succeed or both roll back.
 *
 * @returns {{ transactionRef: string, fromNewBalance: number, toNewBalance: number }}
 */
async function transferFunds(fromAccountId, toAccountId, amount, fee, category, description, notes, createdByUserId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const amt = parseFloat(amount);
    const txnFee = parseFloat(fee || 0);
    const totalDebit = amt + txnFee;

    // Lock both accounts in consistent order (lower ID first to prevent deadlocks)
    const [id1, id2] = fromAccountId < toAccountId
      ? [fromAccountId, toAccountId]
      : [toAccountId, fromAccountId];

    const [rows1] = await conn.query('SELECT id, balance, overdraft_limit, status FROM internal_accounts WHERE id = ? FOR UPDATE', [id1]);
    const [rows2] = await conn.query('SELECT id, balance, overdraft_limit, status FROM internal_accounts WHERE id = ? FOR UPDATE', [id2]);

    if (rows1.length === 0 || rows2.length === 0) throw new Error('One or both accounts not found.');

    const fromAccount = (id1 === fromAccountId ? rows1 : rows2)[0];
    const toAccount   = (id1 === toAccountId   ? rows1 : rows2)[0];

    if (fromAccount.status !== 'active') throw new Error('Source account is not active.');
    if (toAccount.status   !== 'active') throw new Error('Destination account is not active.');

    const fromBalance    = parseFloat(fromAccount.balance);
    const overdraftLimit = parseFloat(fromAccount.overdraft_limit || 0);

    if (fromBalance + overdraftLimit < totalDebit) {
      throw new Error(`Insufficient funds. Available: $${(fromBalance + overdraftLimit).toFixed(2)}`);
    }

    const fromNewBalance = fromBalance - totalDebit;
    const toNewBalance   = parseFloat(toAccount.balance) + amt;

    await conn.query('UPDATE internal_accounts SET balance = ? WHERE id = ?', [fromNewBalance.toFixed(2), fromAccountId]);
    await conn.query('UPDATE internal_accounts SET balance = ? WHERE id = ?', [toNewBalance.toFixed(2), toAccountId]);

    const transactionRef = 'TXN-' + crypto.randomUUID().split('-')[0].toUpperCase();

    await conn.query(
      `INSERT INTO internal_transactions
        (transaction_ref, from_account_id, to_account_id, amount, fee, total_amount,
         transaction_type, category, status, description, notes, created_by, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'transfer', ?, 'completed', ?, ?, ?, NOW(), NOW())`,
      [
        transactionRef,
        fromAccountId,
        toAccountId,
        amt.toFixed(2),
        txnFee.toFixed(2),
        totalDebit.toFixed(2),
        category || 'Transfer',
        description || 'Internal Transfer',
        notes || null,
        createdByUserId || null,
      ]
    );

    await conn.commit();
    return { transactionRef, fromNewBalance, toNewBalance };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * logAudit — write to audit_logs with auto-computed risk level.
 */
async function logAudit(adminId, userId, action, tableName, recordId, oldValue, newValue, connection) {
  const riskLevel = computeRiskLevel(action);
  const sql = `INSERT INTO audit_logs
    (admin_id, user_id, action, table_name, record_id, old_value, new_value, risk_level, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
  const params = [
    adminId  || null,
    userId   || null,
    action,
    tableName || null,
    recordId  || null,
    oldValue  ? JSON.stringify(oldValue)  : null,
    newValue  ? JSON.stringify(newValue)  : null,
    riskLevel,
  ];
  if (connection) {
    await connection.query(sql, params);
  } else {
    await db.query(sql, params);
  }
}

module.exports = { mutateBalance, transferFunds, logAudit };
