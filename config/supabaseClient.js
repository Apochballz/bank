// config/supabaseClient.js
// Initializes the Supabase client for server‑side use (service role key).
// This module is imported by the DB wrapper so the rest of the app can keep using the old query(sql, params) signature.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (!supabase) {
  console.warn('[WARN] Supabase credentials are not configured. Database-backed routes will return a configuration error.');
}

module.exports = supabase;
