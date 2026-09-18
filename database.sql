-- ============================================================
-- Olith Banking — Full Database Schema
-- Run: mysql -u root -p < database.sql
-- ============================================================

-- NOTE: Database must be created manually in cPanel (e.g., cpaneluser_olith_banking)
-- The script now starts directly with table definitions.

-- Create application user (adjust password as needed)
-- CREATE USER IF NOT EXISTS 'olith_app'@'localhost' IDENTIFIED BY 'your_password_here';
-- GRANT ALL PRIVILEGES ON <CPANEL_DB_NAME>.* TO 'olith_app'@'localhost';
-- FLUSH PRIVILEGES;

-- ─── Users ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(30) DEFAULT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'customer',
  status ENUM('active','pending','suspended','closed') DEFAULT 'pending',
  stripe_customer_id VARCHAR(100) DEFAULT NULL,
  email_verified_at TIMESTAMP NULL DEFAULT NULL,
  last_login TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Email Verification Tokens ─────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Password Reset Tokens ─────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Internal Accounts ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS internal_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  account_number VARCHAR(30) UNIQUE NOT NULL,
  account_name VARCHAR(100) NOT NULL,
  account_type ENUM('checking','savings','credit_card','vault') DEFAULT 'savings',
  balance DECIMAL(15,2) DEFAULT 0.00,
  overdraft_limit DECIMAL(15,2) DEFAULT 0.00,
  status ENUM('active','frozen','closed') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Cards ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cards (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  account_id INT UNSIGNED NOT NULL,
  card_number VARCHAR(20) UNIQUE NOT NULL,
  card_type ENUM('debit','credit') DEFAULT 'debit',
  card_provider VARCHAR(30) DEFAULT 'Mastercard',
  expiry_date CHAR(5) NOT NULL,
  cvv CHAR(3) NOT NULL,
  status ENUM('active','inactive','blocked','pending') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES internal_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Internal Transactions (single ledger) ─────────────────
CREATE TABLE IF NOT EXISTS internal_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  transaction_ref VARCHAR(50) UNIQUE NOT NULL,
  from_account_id INT UNSIGNED DEFAULT NULL,
  to_account_id INT UNSIGNED DEFAULT NULL,
  amount DECIMAL(15,2) NOT NULL,
  fee DECIMAL(15,2) DEFAULT 0.00,
  total_amount DECIMAL(15,2) NOT NULL,
  transaction_type ENUM('deposit','withdrawal','transfer','payment','bill_payment','admin_credit','admin_debit') NOT NULL,
  category VARCHAR(50) DEFAULT 'Transfer',
  status ENUM('pending','processing','completed','rejected','failed') DEFAULT 'pending',
  description VARCHAR(255) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  approved_by INT UNSIGNED DEFAULT NULL,
  approved_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_account_id) REFERENCES internal_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (to_account_id) REFERENCES internal_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per completed Financial Connections session (a "connect a bank" action)
CREATE TABLE bank_connections (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_session_id VARCHAR(100) NOT NULL,
  status ENUM('active','disconnected','error') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One row per linked external account (a session can return more than one account)
CREATE TABLE bank_connection_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_connection_id INT UNSIGNED NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  stripe_account_id VARCHAR(100) UNIQUE NOT NULL,
  institution_name VARCHAR(150) DEFAULT NULL,
  display_name VARCHAR(150) DEFAULT NULL,
  last4 CHAR(4) DEFAULT NULL,
  category VARCHAR(30) DEFAULT NULL,      -- 'checking', 'savings', 'credit_card', etc. (Stripe's `subcategory`)
  balance_current DECIMAL(15,2) DEFAULT NULL,
  balance_available DECIMAL(15,2) DEFAULT NULL,
  currency CHAR(3) DEFAULT 'USD',
  status ENUM('active','inactive','error') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bank_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_connection_account_id INT UNSIGNED NOT NULL REFERENCES bank_connection_accounts(id) ON DELETE CASCADE,
  stripe_transaction_id VARCHAR(100) UNIQUE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  currency CHAR(3) DEFAULT 'USD',
  description VARCHAR(255) DEFAULT NULL,
  category VARCHAR(100) DEFAULT NULL,
  status VARCHAR(30) DEFAULT NULL,        -- Stripe's transaction status field
  transacted_at DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Admin Roles ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  permissions JSON NOT NULL
) ENGINE=InnoDB;

-- ─── Tickets ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  subject VARCHAR(200) NOT NULL,
  status ENUM('open','pending','closed') DEFAULT 'open',
  assigned_to INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─── Ticket Messages ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT UNSIGNED NOT NULL,
  sender_id INT UNSIGNED NOT NULL,
  sender_role ENUM('user','admin') NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Notifications ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  title VARCHAR(150),
  body TEXT,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── System Settings ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  key_name VARCHAR(100) UNIQUE NOT NULL,
  key_value TEXT NOT NULL,
  category VARCHAR(50) DEFAULT 'general'
) ENGINE=InnoDB;

-- ─── Bills ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  account_id INT UNSIGNED DEFAULT NULL,
  bill_name VARCHAR(150) NOT NULL,
  merchant_name VARCHAR(150) DEFAULT NULL,
  amount DECIMAL(10,2) NOT NULL,
  due_date DATE NOT NULL,
  status ENUM('upcoming','paid','overdue','cancelled') DEFAULT 'upcoming',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES internal_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─── Savings Goals ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS savings_goals (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  vault_account_id INT UNSIGNED NULL,
  goal_name VARCHAR(150) NOT NULL,
  target_amount DECIMAL(15,2) NOT NULL,
  current_amount DECIMAL(15,2) DEFAULT 0.00,
  target_date DATE NOT NULL,
  status ENUM('active','completed','paused') DEFAULT 'active',
  auto_enabled BOOLEAN DEFAULT FALSE,
  auto_amount DECIMAL(15,2) DEFAULT NULL,
  auto_frequency ENUM('weekly','monthly') DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (vault_account_id) REFERENCES internal_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─── Audit Logs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id INT UNSIGNED DEFAULT NULL,
  user_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(100) NOT NULL,
  table_name VARCHAR(100) DEFAULT NULL,
  record_id INT UNSIGNED DEFAULT NULL,
  old_value JSON DEFAULT NULL,
  new_value JSON DEFAULT NULL,
  risk_level ENUM('low','medium','high') DEFAULT 'low',
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- SEED DATA
-- ============================================================

-- Admin roles
INSERT INTO admin_roles (name, permissions) VALUES
  ('admin', '["users_manage","accounts_manage","transactions_manage","cards_manage","tickets_manage","reports_view","audit_view"]'),
  ('super_admin', '["users_manage","accounts_manage","transactions_manage","cards_manage","tickets_manage","reports_view","audit_view","system_settings","admins_manage","backup_db","restore_db"]')
ON DUPLICATE KEY UPDATE permissions = VALUES(permissions);

-- Default system settings
INSERT INTO system_settings (key_name, key_value, category) VALUES
  ('app_name',               'Olith Banking',    'general'),
  ('maintenance_mode',       'false',             'general'),
  ('transfer_fee_percent',   '0',                 'financial'),
  ('max_transfer_amount',    '50000',             'financial'),
  ('auto_approve_transfers', 'true',              'financial')
ON DUPLICATE KEY UPDATE key_value = VALUES(key_value);

-- Seed super_admin account (password: Admin@123456)
-- bcrypt hash of 'Admin@123456' with 10 rounds
INSERT INTO users (full_name, email, password, role, status, email_verified_at)
VALUES (
  'System Admin',
  'admin@olithbanking.com',
  '$2a$10$qS3GBz3BBFHi3MnxGpYq6egJr1oFzVxJQ7fI1.3cLxBXvn7yfEyZS',
  'super_admin',
  'active',
  NOW()
)
ON DUPLICATE KEY UPDATE role = 'super_admin', status = 'active';
