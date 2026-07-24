import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { count } = await s.from('fetched_html_cache').select('lead_id', { count: 'exact', head: true }).not('html', 'is', null)
  console.log('non-null html cache rows total:', count)
})()
