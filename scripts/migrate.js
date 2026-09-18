const mysql = require('mysql2/promise');

async function migrate() {
  const c = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: '', database: 'olith_banking' });
  try {
    await c.query('DROP TABLE IF EXISTS plaid_transactions, plaid_accounts, plaid_items');
    try {
      await c.query('ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(100) DEFAULT NULL');
    } catch(e) {} // ignore if exists
    await c.end();
    console.log('Migrated');
  } catch(e) {
    console.error(e);
  }
}
migrate();
