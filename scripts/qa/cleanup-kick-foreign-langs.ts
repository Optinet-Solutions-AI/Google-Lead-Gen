/**
 * One-off cleanup: remove foreign-language Kick streamer rows that were
 * stored BEFORE the language filter shipped (commit 87b2364, 2026-06-05).
 *
 * Mirrors vm/kick_search.py's filter exactly: keep streamers whose stream
 * language is in the job-country's allowed set (gologin_profiles.languages,
 * e.g. ['en'] for AU) OR are untagged; everything else is foreign and gets
 * deleted. kick_links cascade-delete with their streamer.
 *
 *   npx tsx scripts/qa/cleanup-kick-foreign-langs.ts            # dry-run (default)
 *   npx tsx scripts/qa/cleanup-kick-foreign-langs.ts --apply    # actually delete
 *
 * Target job defaults to the original AU "online casino" QA-report job;
 * override any job with  --job <scrape_queue_id>
 */
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: '.env.local' })

// The original AU "online casino" Kick job from the QA report.
const DEFAULT_JOB = '9c39ecb3-4b6a-48a9-8b4e-d9bd3b90fac6'

// Port of vm/kick_search.py _LANG_NAME_TO_CODE — keep in sync.
const NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  spanish: 'es', 'español': 'es', espanol: 'es', castellano: 'es',
  portuguese: 'pt', 'português': 'pt', portugues: 'pt',
  french: 'fr', 'français': 'fr', francais: 'fr',
  german: 'de', deutsch: 'de',
  italian: 'it', italiano: 'it',
  dutch: 'nl', nederlands: 'nl',
  polish: 'pl', polski: 'pl',
  turkish: 'tr', 'türkçe': 'tr', turkce: 'tr',
  russian: 'ru', 'русский': 'ru',
  arabic: 'ar', 'العربية': 'ar',
  japanese: 'ja', '日本語': 'ja',
  korean: 'ko', '한국어': 'ko',
  chinese: 'zh', '中文': 'zh',
  hindi: 'hi',
  swedish: 'sv', svenska: 'sv',
  norwegian: 'no', norsk: 'no',
  danish: 'da', dansk: 'da',
  finnish: 'fi', suomi: 'fi',
  czech: 'cs', 'čeština': 'cs', cestina: 'cs',
  greek: 'el', 'ελληνικά': 'el',
  romanian: 'ro', 'română': 'ro', romana: 'ro',
  hungarian: 'hu', magyar: 'hu',
  thai: 'th', 'ไทย': 'th',
  vietnamese: 'vi', 'tiếng việt': 'vi',
  indonesian: 'id', 'bahasa indonesia': 'id',
  filipino: 'tl', tagalog: 'tl',
}

function normalizeLangCode(raw: string | null | undefined): string {
  if (!raw) return ''
  let v = raw.trim().toLowerCase()
  if (!v) return ''
  if (v.includes('-')) v = v.split('-', 1)[0].trim()
  if (v.length === 2) return v
  return NAME_TO_CODE[v] ?? v
}

async function main() {
  const apply = process.argv.includes('--apply')
  const jobIdx = process.argv.indexOf('--job')
  const jobId = jobIdx >= 0 ? process.argv[jobIdx + 1] : DEFAULT_JOB

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // 1. Resolve the job + its country's allowed languages (same source the
  //    worker uses).
  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine, created_at')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) throw jobErr
  if (!job) {
    console.log(`Job ${jobId} not found. Nothing to do.`)
    return
  }
  if (job.search_engine !== 'kick') {
    console.log(`Job ${jobId} is search_engine=${job.search_engine}, not kick. Aborting.`)
    return
  }

  const { data: profile } = await svc
    .from('gologin_profiles')
    .select('languages')
    .eq('country_code', job.country_code)
    .maybeSingle()
  const allowed = (profile?.languages?.length ? profile.languages : ['en']) as string[]
  const keep = new Set(allowed.map((l) => l.trim().toLowerCase()).filter(Boolean))
  if (keep.size === 0) keep.add('en')

  console.log(`Job:      ${jobId}`)
  console.log(`Keyword:  ${job.keyword} | country=${job.country_code} | created=${job.created_at}`)
  console.log(`Keep set: [${[...keep].join(', ')}] (foreign-tagged rows will be removed; untagged kept)`)
  console.log('')

  // 2. Pull all streamer rows for the job.
  const { data: rows, error: rowsErr } = await svc
    .from('kick_streamers')
    .select('id, slug, stream_language')
    .eq('scrape_queue_id', jobId)
  if (rowsErr) throw rowsErr
  const all = rows ?? []

  // 3. Classify (mirror the Python filter).
  const toDelete: { id: string; slug: string; code: string }[] = []
  const byLang: Record<string, number> = {}
  let kept = 0
  let untagged = 0
  for (const r of all) {
    const code = normalizeLangCode(r.stream_language)
    if (code === '') { untagged++; kept++; continue }
    if (keep.has(code)) { kept++; continue }
    toDelete.push({ id: r.id, slug: r.slug, code })
    byLang[code] = (byLang[code] ?? 0) + 1
  }

  const breakdown = Object.entries(byLang).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join(', ')
  console.log(`Total rows:     ${all.length}`)
  console.log(`Keeping:        ${kept} (incl. ${untagged} untagged)`)
  console.log(`To delete:      ${toDelete.length} [${breakdown}]`)
  if (toDelete.length) {
    console.log('Sample of rows to delete:')
    for (const d of toDelete.slice(0, 10)) console.log(`   - ${d.slug} (${d.code})`)
    if (toDelete.length > 10) console.log(`   ... and ${toDelete.length - 10} more`)
  }
  console.log('')

  if (toDelete.length === 0) {
    console.log('Nothing to delete. Done.')
    return
  }

  if (!apply) {
    console.log('DRY RUN — no rows deleted. Re-run with --apply to perform the deletion.')
    return
  }

  // 4. Delete in batches (kick_links cascade via FK on delete cascade).
  const ids = toDelete.map((d) => d.id)
  let deleted = 0
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const { error: delErr, count } = await svc
      .from('kick_streamers')
      .delete({ count: 'exact' })
      .in('id', batch)
    if (delErr) throw delErr
    deleted += count ?? batch.length
  }
  console.log(`DELETED ${deleted} foreign-language streamer rows (kick_links cascaded).`)

  // 5. Confirm post-state.
  const { count: remaining } = await svc
    .from('kick_streamers')
    .select('id', { count: 'exact', head: true })
    .eq('scrape_queue_id', jobId)
  console.log(`Remaining streamers on job: ${remaining}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
