/**
 * Shared CORS headers for all Supabase Edge Functions.
 * Restricts to specific origins in production; expand as needed.
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',   // tighten to your domain in production
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};
