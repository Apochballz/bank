// config/supabaseClient.js
// Initializes the Supabase client for server‑side use (service role key).
// This module is imported by the DB wrapper so the rest of the app can keep using the old query(sql, params) signature.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder_service_role_key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[WARN] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Set these in Vercel or .env for database operations.');
}

// Create a Supabase client that uses the service‑role key which has full DB privileges.
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
