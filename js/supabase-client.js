// Supabase Client Configuration
// Credentials are loaded from config.js (not committed to git)
// See config.example.js for the template

const supabase = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
);

export { supabase };
