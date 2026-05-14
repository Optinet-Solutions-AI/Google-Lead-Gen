/**
 * One-off: print the current qa_feedback queue grouped by status,
 * so we can pick what to work on next. Read-only.
 *
 * Run: npx tsx scripts/qa/peek-feedback.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

type Row = {
  id: number
  user_display: string | null
  user_email: string | null
  url: string | null
  message: string
  status: 'open' | 'in_progress' | 'resolved' | 'rejected'
  created_at: string
  updated_at: string
  resolved_by: string | null
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await svc
    .from('qa_feedback')
    .select(
      'id, user_display, user_email, url, message, status, created_at, updated_at, resolved_by',
    )
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw error
  const rows = (data ?? []) as Row[]

  const byStatus: Record<Row['status'], Row[]> = {
    open: [],
    in_progress: [],
    resolved: [],
    rejected: [],
  }
  for (const r of rows) byStatus[r.status].push(r)

  console.log(`Total: ${rows.length}`)
  for (const s of ['open', 'in_progress', 'resolved', 'rejected'] as const) {
    console.log(`  ${s}: ${byStatus[s].length}`)
  }
  console.log('')

  for (const s of ['open', 'in_progress', 'resolved'] as const) {
    const bucket = byStatus[s]
    if (bucket.length === 0) continue
    console.log(`\n=== ${s.toUpperCase()} (${bucket.length}) ===\n`)
    for (const r of bucket) {
      const age = Math.floor(
        (Date.now() - new Date(r.created_at).getTime()) / 86_400_000,
      )
      console.log(`#${r.id}  ${age}d old  by ${r.user_display ?? r.user_email ?? 'unknown'}`)
      if (r.url) console.log(`  URL: ${r.url}`)
      console.log(`  ${r.message.replace(/\n+/g, ' ').slice(0, 280)}${r.message.length > 280 ? '…' : ''}`)
      console.log('')
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
