// config/db.js
// PostgreSQL adapter for Supabase's hosted Postgres database.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const hasDatabaseConfig = Boolean(
  connectionString ||
  (process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME)
);

const pool = hasDatabaseConfig
  ? new Pool({
      ...(connectionString
        ? { connectionString }
        : {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 5432),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
          }),
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_CONNECTION_LIMIT || 5),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    })
  : null;

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function addReturningId(sql) {
  if (/^\s*INSERT\s+INTO\s+/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
    return `${sql.trim()} RETURNING id`;
  }
  return sql;
}

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('Database is not configured. Add DATABASE_URL or Supabase Postgres connection variables.');
  }

  const text = addReturningId(convertPlaceholders(sql));
  const result = await pool.query(text, params);
  const rows = result.rows || [];

  if (/^\s*INSERT\s+INTO\s+/i.test(sql)) {
    rows.insertId = rows[0]?.id ?? null;
  }
  rows.affectedRows = result.rowCount || 0;
  return [rows];
}

function getConnection() {
  if (!pool) {
    throw new Error('Database is not configured. Add DATABASE_URL or Supabase Postgres connection variables.');
  }

  let client;
  return {
    query,
    beginTransaction: async () => {
      client = await pool.connect();
      await client.query('BEGIN');
    },
    commit: async () => {
      if (client) await client.query('COMMIT');
    },
    rollback: async () => {
      if (client) await client.query('ROLLBACK');
    },
    release: () => client?.release(),
  };
}

(async () => {
  if (!hasDatabaseConfig) {
    console.warn('[DB] Supabase Postgres credentials are not configured.');
    return;
  }
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Supabase Postgres connection verified.');
  } catch (err) {
    console.error('[DB] Supabase Postgres connection failed:', err.message);
  }
})();

module.exports = { query, getConnection };

process.on('SIGTERM', async () => {
  if (pool) await pool.end();
});
process.on('SIGINT', async () => {
  if (pool) await pool.end();
});
process.on('uncaughtException', (err) => {
  console.error('[DB] Unexpected database process error:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[DB] Unhandled database rejection:', err);
});

module.exports.pool = pool;
