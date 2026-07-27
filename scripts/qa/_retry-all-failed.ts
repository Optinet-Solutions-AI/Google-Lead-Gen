/**
 * Re-queue every phase-1 row currently in status=failed, regardless of
 * error reason. For each row, the dedup guard skips if any (keyword ×
 * country × engine) sibling is already pending / running / captcha so
 * nothing stacks.
 *
 * Complements _retry-proxy-failures.ts (which only targets proxy errors
 * with a 14d lookback). This one is unrestricted — it drains the whole
 * accumulated failed-queue so those rows either succeed cleanly or land
 * as fresh captcha checkpoints the operator can solve.
 *
 * Priority 60: below the interactive-solve retries at 80, above idle
 * backfill. Args: --dry to preview.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const DRY = process.argv.includes('--dry')
const IN_FLIGHT = ['pending', 'running', 'captcha']

;(async () => {
  const { data } = await s
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, ' +
        'pages, priority, with_enrichment, language, view_mode, ' +
        'top_n_by_follower, result_type_filter, ' +
        'created_by_email, created_by_username, created_by_display, created_by_is_shadow, ' +
        'parent_scrape_job_id, error_message',
    )
    .eq('status', 'failed')
    .is('parent_scrape_job_id', null)
    .order('created_at', { ascending: false })
  const rows = (data ?? []) as Array<Record<string, unknown>>
  console.log(`Mode: ${DRY ? 'DRY RUN' : 'EXECUTE'}`)
  console.log(`Found ${rows.length} failed phase-1 rows.\n`)

  let requeued = 0, skipped = 0, skippedCompleted = 0, errored = 0

  for (const src of rows) {
    const { data: inFlight } = await s
      .from('scrape_queue')
      .select('id, status')
      .eq('keyword', src.keyword)
      .eq('country_code', src.country_code)
      .eq('search_engine', src.search_engine)
      .in('status', IN_FLIGHT)
      .is('parent_scrape_job_id', null)
    if (inFlight && inFlight.length > 0) {
      skipped++
      const statuses = (inFlight as Array<{ status: string }>).map(r => r.status).join(',')
      console.log(`  SKIP  ${src.country_code}/${String(src.search_engine).padEnd(8)}  ${String(src.keyword).slice(0, 55).padEnd(55)}  in-flight: ${statuses}`)
      continue
    }

    // 2026-07-27: ALSO skip if a sibling already COMPLETED. This is the
    // fix for the clone-explosion — a keyword that failed-then-succeeded
    // has a lingering `failed` source row that this script kept
    // re-cloning every run (in-flight check alone never caught it, and
    // completed keywords don't need re-scraping). Mirrors the enqueue
    // guard's "window = ever" rule; matches lib/scrape/find-completed-siblings.ts.
    const { data: doneSibling } = await s
      .from('scrape_queue')
      .select('id, completed_at')
      .eq('keyword', src.keyword)
      .eq('country_code', src.country_code)
      .eq('search_engine', src.search_engine)
      .eq('status', 'completed')
      .is('parent_scrape_job_id', null)
      .limit(1)
    if (doneSibling && doneSibling.length > 0) {
      skippedCompleted++
      const when = (doneSibling[0] as { completed_at: string | null }).completed_at?.slice(0, 10) ?? '?'
      console.log(`  DONE  ${src.country_code}/${String(src.search_engine).padEnd(8)}  ${String(src.keyword).slice(0, 55).padEnd(55)}  already completed ${when} — not re-cloning`)
      continue
    }

    if (DRY) {
      console.log(`  WOULD ${src.country_code}/${String(src.search_engine).padEnd(8)}  ${String(src.keyword).slice(0, 55).padEnd(55)}`)
      requeued++
      continue
    }

    const clone = {
      keyword: src.keyword,
      country_code: src.country_code,
      pages: src.pages,
      priority: 60,
      with_enrichment: src.with_enrichment,
      language: src.language,
      search_engine: src.search_engine,
      view_mode: src.view_mode,
      top_n_by_follower: src.top_n_by_follower ?? null,
      result_type_filter: src.result_type_filter,
      created_by_email: src.created_by_email,
      created_by_username: src.created_by_username,
      created_by_display: src.created_by_display,
      created_by_is_shadow: src.created_by_is_shadow,
    }
    const { data: inserted, error } = await s
      .from('scrape_queue')
      .insert(clone)
      .select('id')
    if (error) {
      errored++
      console.log(`  FAIL  ${src.country_code}/${String(src.search_engine).padEnd(8)}  ${String(src.keyword).slice(0, 55).padEnd(55)}  ${error.message}`)
      continue
    }
    const id = ((inserted ?? []) as Array<{ id: string }>)[0]?.id
    console.log(`  RETRY ${src.country_code}/${String(src.search_engine).padEnd(8)}  ${String(src.keyword).slice(0, 55).padEnd(55)}  ${id}`)
    requeued++
  }

  if (!DRY && requeued > 0) {
    await s.from('activity_log').insert({
      action: 'scrape.rerun_bulk',
      entity_type: 'scrape_jobs_bulk',
      actor_email: 'system@cleanup',
      details: {
        script: 'scripts/qa/_retry-all-failed.ts',
        purpose: 'Bulk retry of accumulated hard-failed phase-1 rows so they can hit captcha instead',
        found: rows.length,
        retried: requeued,
        skipped_dedup: skipped,
        skipped_completed: skippedCompleted,
        errored,
      },
    })
  }

  console.log(`\nSummary: ${DRY ? 'would retry' : 'retried'} ${requeued}, skipped ${skipped} (in flight), skipped ${skippedCompleted} (already completed — the clone-explosion fix), errored ${errored}`)
  console.log(`Solve as they land: https://google-lead-gen.vercel.app/admin/interactive`)
})().catch(e => { console.error(e); process.exit(1) })
