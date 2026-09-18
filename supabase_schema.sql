-- supabase_schema.sql
-- PostgreSQL schema for the Olith Banking app (to be run in Supabase's SQL editor)
-- This replaces the previous MySQL `database.sql` script.

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT CHECK (role IN ('user', 'admin')) DEFAULT 'user',
  created_at    TIMESTAMPTZ DEFAULT now(),
  status        TEXT CHECK (status IN ('pending','active','suspended','closed')) DEFAULT 'active',
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Accounts table (each user can have many accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
  account_name  TEXT NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Transactions table (links to an account)
CREATE TABLE IF NOT EXISTS transactions (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  amount_cents  BIGINT NOT NULL,
  description   TEXT,
  status        TEXT CHECK (status IN ('pending', 'settled', 'failed')) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Bills table (user‑issued bills)
CREATE TABLE IF NOT EXISTS bills (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  BIGINT NOT NULL,
  due_date      DATE,
  paid          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Goals table (savings goals for a user)
CREATE TABLE IF NOT EXISTS goals (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  target_cents  BIGINT NOT NULL,
  current_cents BIGINT NOT NULL DEFAULT 0,
  deadline      DATE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Tickets table (support tickets)
CREATE TABLE IF NOT EXISTS tickets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT CHECK (status IN ('open', 'closed', 'pending')) DEFAULT 'open',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Optional: admin audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Indexes for fast look‑ups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);

-- Helper function to allow arbitrary SQL execution (required by the DB wrapper).
-- This must be created once in Supabase.
CREATE OR REPLACE FUNCTION public.raw_sql(sql TEXT)
RETURNS SETOF RECORD
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE sql;
END;
$$;
-- OPTIONAL: Seed an initial admin user
INSERT INTO users (full_name, email, password_hash, role, status)
VALUES (
  'Admin',
  'thankgodapochi2@gmail.com',
  '$2b$10$q8mslZIN3FSV1WOwqDoi.OsmKMvNZBxeu58A7PVHXt1EqCUXYs3Fe',
  'admin',
  'active'
)
ON CONFLICT (email) DO NOTHING;
