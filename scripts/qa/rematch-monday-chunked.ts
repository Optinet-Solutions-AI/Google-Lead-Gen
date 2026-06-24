/**
 * Chunked rematch — calls rematch_monday_for_leads on batches of
 * lead IDs so we don't hit Postgres's statement_timeout on the full
 * 34k-row sweep.
 *
 *   CHUNK=500 npx tsx scripts/qa/rematch-monday-chunked.ts
 *
 * CHUNK defaults to 500. Lower if you still see timeouts.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const CHUNK = Number(process.env.CHUNK ?? 500)
  console.log(`Loading lead IDs in chunks of ${CHUNK} …`)

  // Page through all leads without an override, ascending. Supabase
  // PostgREST default-caps SELECT at 1000 per request; loop until a
  // page comes back smaller than that.
  const PAGE = 1000
  const ids: number[] = []
  let cursor: number | null = null
  while (true) {
    let q = svc
      .from('google_lead_gen_table')
      .select('id')
      .is('monday_overridden_at', null)
      .order('id', { ascending: true })
      .range(0, PAGE - 1)
    if (cursor !== null) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw error
    const rows = (data ?? []) as Array<{ id: number }>
    if (rows.length === 0) break
    for (const r of rows) ids.push(r.id)
    cursor = rows[rows.length - 1]!.id
    if (rows.length < PAGE) break
  }
  console.log(`Loaded ${ids.length} lead IDs.`)

  let totalChecked = 0
  let totalFlipped = 0
  const t0 = Date.now()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data, error } = await svc.rpc('rematch_monday_for_leads', { p_lead_ids: slice })
    if (error) {
      console.error(`  chunk ${i}-${i + slice.length} ERROR: ${error.message}`)
      continue
    }
    const row = Array.isArray(data) ? (data[0] as { checked?: number; flipped?: number } | undefined) : undefined
    totalChecked += row?.checked ?? 0
    totalFlipped += row?.flipped ?? 0
    if ((i / CHUNK) % 10 === 0 || i + CHUNK >= ids.length) {
      console.log(
        `  ${i + slice.length}/${ids.length}  (this chunk: checked=${row?.checked ?? 0}, flipped=${row?.flipped ?? 0})`,
      )
    }
  }
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — checked=${totalChecked}, flipped=${totalFlipped}`)
}

main().catch(err => { console.error(err); process.exit(1) })
