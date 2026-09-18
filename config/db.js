// config/db.js
// MySQL-compatible database adapter for the original application schema.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  queueLimit: 0,
  enableKeepAlive: true,
  connectTimeout: 10000,
});

/**
 * Keeps the original mysql2-style `[rows]` return shape used by the routes.
 * Parameters remain bound by mysql2 rather than interpolated into SQL.
 */

async function query(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  const rows = Array.isArray(result) ? result : [];

  if (!Array.isArray(result)) {
    rows.insertId = result.insertId;
    rows.affectedRows = result.affectedRows;
  } else {
    rows.affectedRows = rows.length;
  }

  return [rows];
}

/**
 * For compatibility with code that explicitly requests a connection (e.g. for
 * multi‑statement transactions). Supabase does not expose a raw connection, so
 * we expose a dummy object that satisfies the interface.
 */
function getConnection() {
  // Preserve the existing route/service contract while sharing the pool.
  return {
    query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
}

// Verify connection on startup – a simple ping query.
(async () => {
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    console.log('[DB] Database credentials not set. Skipping connection verification.');
    return;
  }
  try {
    await query('SELECT 1');
    console.log('[DB] MySQL connection verified.');
  } catch (err) {
    console.error('[DB] MySQL connection failed:', err.message);
  }
})();

module.exports = { query, getConnection };
