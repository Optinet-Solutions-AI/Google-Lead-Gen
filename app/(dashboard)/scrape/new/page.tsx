import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/require-admin'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { listActiveProfiles } from '../_lib/queries'
import { NewScrapeWizard } from './_components/new-scrape-wizard'
import { engineDef, utcDay, type DayUsage, type LastConfig, type QuotaPreview, type ScrapeDraft } from './_lib/wizard-helpers'

export const dynamic = 'force-dynamic'

type SearchParams = { [key: string]: string | string[] | undefined }

const DEFAULT_CAP = 20
const DAYS_AHEAD = 7

type QueueRow = {
  id: string
  keyword: string
  country_code: string
  language: string | null
  pages: number | null
  view_mode: 'both' | 'desktop' | 'mobile' | null
  with_enrichment: boolean | null
  search_engine: string | null
  scheduled_at: string | null
  created_at: string
  top_n_by_follower: number | null
  result_type_filter: string | null
}

/** True when an ISO instant lies ahead of the request time. */
function isFuture(iso: string | null): boolean {
  return !!iso && new Date(iso).getTime() > Date.now()
}

const ROW_COLS =
  'id, keyword, country_code, language, pages, view_mode, with_enrichment, search_engine, scheduled_at, created_at, top_n_by_follower, result_type_filter'

/**
 * /scrape/new — admin-only UI preview of the step-by-step scrape wizard.
 * Read-only against the database: loads country profiles, the caller's
 * quota picture for the next days, and their last scrape to offer "use
 * last configuration". Nothing is written.
 */
export default async function NewScrapePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const admin = await requireAdmin()
  if (!admin.ok) redirect('/scrape')

  const sp = await searchParams
  const fromId = typeof sp.from === 'string' ? sp.from : null

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const email = (user?.email ?? '').toLowerCase()
  const svc = createServiceClient()

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const [profiles, capRaw, bypassRow, usageRows, recentRows, fromRow] = await Promise.all([
    listActiveProfiles(),
    svc.rpc('get_system_setting', { p_key: 'daily_scrape_cap_per_user' }).then(r => r.data as unknown),
    user
      ? svc.from('user_profiles').select('bypass_scrape_cap').eq('id', user.id).maybeSingle().then(r => r.data as { bypass_scrape_cap: boolean | null } | null)
      : Promise.resolve(null),
    email
      ? svc
          .from('scrape_queue')
          .select('keyword, country_code, scheduled_at, created_at')
          .eq('created_by_email', email)
          .is('parent_scrape_job_id', null)
          .or('is_rerun.is.null,is_rerun.eq.false')
          .or(`created_at.gte.${todayIso},scheduled_at.gte.${todayIso}`)
          .then(r => (r.data ?? []) as Array<Pick<QueueRow, 'keyword' | 'country_code' | 'scheduled_at' | 'created_at'>>)
      : Promise.resolve([]),
    email
      ? svc
          .from('scrape_queue')
          .select(ROW_COLS)
          .eq('created_by_email', email)
          .is('parent_scrape_job_id', null)
          .order('created_at', { ascending: false })
          .limit(80)
          .then(r => (r.data ?? []) as unknown as QueueRow[])
      : Promise.resolve([] as QueueRow[]),
    fromId && email
      ? svc.from('scrape_queue').select(ROW_COLS).eq('id', fromId).eq('created_by_email', email).maybeSingle().then(r => (r.data ?? null) as unknown as QueueRow | null)
      : Promise.resolve(null),
  ])

  // ----- quota preview (shown even to exempt users so the UI can be tested) -----
  const capNum = typeof capRaw === 'number' ? capRaw : typeof capRaw === 'string' ? Number(capRaw) : DEFAULT_CAP
  const cap = Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : null
  const exempt = bypassRow?.bypass_scrape_cap === true

  const usedByDay = new Map<string, Set<string>>()
  for (const r of usageRows) {
    const when = r.scheduled_at ?? r.created_at
    if (!when || when < todayIso) continue
    const day = utcDay(when)
    const set = usedByDay.get(day) ?? new Set<string>()
    set.add(`${(r.keyword ?? '').toLowerCase()}|${r.country_code}`)
    usedByDay.set(day, set)
  }
  const days: DayUsage[] = []
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(todayStart.getTime() + i * 86_400_000)
    const day = utcDay(d)
    days.push({ day, used: usedByDay.get(day)?.size ?? 0 })
  }
  // Any scheduled day beyond the window still shows up if it has usage.
  for (const [day, set] of usedByDay) if (!days.some(x => x.day === day)) days.push({ day, used: set.size })
  days.sort((a, b) => a.day.localeCompare(b.day))
  const quota: QuotaPreview = { cap, exempt, days }

  // ----- last configuration: the most recent submit, all its keywords -----
  let lastConfig: LastConfig | null = null
  const first = recentRows.find(r => r.result_type_filter !== 'PPC') ?? recentRows[0]
  if (first) {
    const stamp = first.created_at.slice(0, 19)
    const sameSubmit = recentRows.filter(
      r => r.created_at.slice(0, 19) === stamp && r.country_code === first.country_code && (r.search_engine ?? 'google') === (first.search_engine ?? 'google'),
    )
    const keywords = [...new Set(sameSubmit.map(r => r.keyword.trim()).filter(Boolean))]
    lastConfig = {
      search_engine: first.search_engine ?? 'google',
      country_code: first.country_code,
      language: first.language ?? 'en',
      pages: first.pages ?? 1,
      view_mode: first.view_mode ?? 'both',
      with_enrichment: first.with_enrichment === true,
      top_n_by_follower: first.top_n_by_follower ?? null,
      keywords,
      created_at: first.created_at,
    }
  }

  // ----- prefill from "Edit" on the today's-queue page -----
  let prefill: Partial<ScrapeDraft> | null = null
  if (fromRow) {
    const eng = engineDef(fromRow.search_engine)?.key ?? 'google'
    const scheduledFuture = isFuture(fromRow.scheduled_at)
    prefill = {
      mode: scheduledFuture ? 'schedule' : 'now',
      scheduled_at: scheduledFuture ? fromRow.scheduled_at : null,
      search_engine: eng,
      country_code: fromRow.country_code,
      language: fromRow.language ?? 'en',
      pages: fromRow.pages ?? 1,
      view_mode: fromRow.view_mode ?? 'both',
      keywords: [fromRow.keyword],
      with_enrichment: fromRow.with_enrichment === true,
      enrichment_stages: fromRow.with_enrichment ? ['affiliate', 'rooster'] : [],
      top_n_by_follower: fromRow.top_n_by_follower ?? null,
      duplicate_override: false,
    }
  }

  return (
    <NewScrapeWizard
      profiles={profiles.map(p => ({
        country_code: p.country_code,
        country_name: p.country_name,
        requires_google_login: p.requires_google_login,
        is_google_logged_in: p.is_google_logged_in,
        languages: p.languages,
      }))}
      quota={quota}
      lastConfig={lastConfig}
      prefill={prefill}
    />
  )
}
