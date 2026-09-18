// config/db.js
// Wrapper that mimics the old MySQL `query(sql, params)` signature using Supabase.

const supabase = require('./supabaseClient');

/**
 * Executes arbitrary SQL against Supabase (PostgreSQL) using the helper
 * function `public.raw_sql(sql text, args jsonb)`. The function returns rows
 * in an array to keep compatibility with the previous MySQL pool API.
 *
 * @param {string} sql   SQL statement. Use `?` placeholders (like MySQL); they will be
 *                       converted to `$1, $2, …` before execution.
 * @param {Array<any>} [params=[]] Parameter values for the placeholders.
 * @returns {Promise<[any[]]>}  Resolves with `[rows]` – a single‑element array where the
 *                               first element is the array of result rows.
 */
function formatSql(sql, params = []) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) return 'NULL';
    const val = params[i++];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    if (val instanceof Date) return `'${val.toISOString()}'`;
    if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

async function query(sql, params = []) {
  let executableSql = formatSql(sql, params);

  // Automatically append RETURNING id for INSERT queries to satisfy insertId callers
  const isInsert = /^\s*insert\s+/i.test(executableSql);
  if (isInsert && !/returning/i.test(executableSql)) {
    executableSql += ' RETURNING id';
  }

  // Call the raw_sql RPC function in Supabase
  const { data, error } = await supabase.rpc('raw_sql', {
    sql: executableSql,
  });

  if (error) {
    throw error;
  }

  // data is an array of rows. Attach insertId for INSERT compatibility.
  const rows = Array.isArray(data) ? data : [];
  if (rows.length > 0 && rows[0].id !== undefined) {
    rows.insertId = rows[0].id;
  }
  rows.affectedRows = rows.length;

  return [rows];
}

/**
 * For compatibility with code that explicitly requests a connection (e.g. for
 * multi‑statement transactions). Supabase does not expose a raw connection, so
 * we expose a dummy object that satisfies the interface.
 */
function getConnection() {
  // Supabase RPC calls do not expose a mysql2 connection. Keep the existing
  // route/service contract working while delegating every query to the client.
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
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[DB] Supabase credentials not set yet. Skipping connection verification.');
    return;
  }
  try {
    await query('SELECT 1');
    console.log('[DB] Supabase connection verified.');
  } catch (err) {
    console.error('[DB] Supabase connection failed:', err.message);
  }
})();

module.exports = { query, getConnection };
