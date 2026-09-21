import 'dotenv/config';
import { verifySupabaseTokenLocally } from '../src/server/trpc/context';
import { supabaseAdmin } from '../src/lib/supabase';

async function run() {
  const testEmail = 'jwks_real_test_' + Date.now() + '@sheriabot.test';
  const testPassword = 'TestPassword!12345678';
  
  const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true
  });
  
  if (createError) {
    console.error('createUser error:', createError);
    return;
  }
  
  const createdUserId = createData.user.id;
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    
    if (authError || !authData.session) {
      throw new Error(`signInWithPassword error: ${authError?.message}`);
    }
    
    const token = authData.session.access_token;
    console.log('[1] Token acquired for Supabase user:', createdUserId);
    
    const t0 = performance.now();
    const res = await verifySupabaseTokenLocally(token);
    const elapsed = performance.now() - t0;
    
    console.log('[2] Local JWKS Verification Status:', res.status, '| Elapsed:', elapsed.toFixed(2), 'ms');
    if (res.status === 'VALID') {
      console.log('    - Decoded sub:     ', res.payload.sub);
      console.log('    - Sub Match:       ', res.payload.sub === createdUserId);
      console.log('    - Email:           ', res.payload.email);
      console.log('    - Role:            ', res.payload.role);
    } else {
      console.error('    - Error Reason:    ', res.reason);
    }
    
    // Warm execution test (cached JWKS)
    const t1 = performance.now();
    const warmRes = await verifySupabaseTokenLocally(token);
    const warmElapsed = performance.now() - t1;
    console.log('[3] Warm JWKS Verification (cached key):', warmRes.status, '| Elapsed:', warmElapsed.toFixed(2), 'ms');
  } finally {
    await supabaseAdmin.auth.admin.deleteUser(createdUserId);
    console.log('[4] Test user cleaned up.');
  }
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
