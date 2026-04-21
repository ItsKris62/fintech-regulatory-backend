import { createClient } from '@supabase/supabase-js';

/**
 * Supabase admin client  -  uses the service role key.
 * Bypasses Row Level Security. NEVER expose this to the frontend.
 * Used for: creating users, admin auth operations, and backend-only queries.
 */
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Supabase public client  -  uses the anon key.
 * Used for: proxying user sign-in / sign-up from the backend when we want
 * Supabase to issue the JWT directly.
 */
export const supabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Create a per-request Supabase client that scopes operations to the
 * authenticated user by forwarding their Bearer token.
 */
export function createUserSupabaseClient(accessToken: string) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
