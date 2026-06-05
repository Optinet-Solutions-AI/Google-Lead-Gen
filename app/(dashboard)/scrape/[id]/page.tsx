import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import { getShadowContext } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'
import { translateKeywordsToEnglish } from '@/lib/translate'
import { AdvancedFilters } from '../../_components/advanced-filters'
import { Pagination } from '../../monday/_components/pagination'
import { LeadsTable } from '../../leads/_components/leads-table'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  LEAD_PAGE_SIZES,
  queryLeads,
} from '../../leads/_lib/query'
import { AutoRefresh } from '../_components/auto-refresh'
import { CaptchaRecoveryBanner } from '../_components/captcha-recovery-banner'
import { MobileSkippedRetryBanner } from '../_components/mobile-skipped-retry-banner'
import { EnrichmentStages } from '../_components/enrichment-stages'
import { KickStreamersPanel } from '../_components/kick-streamers-panel'
import { KickStreamersTable } from '../_components/kick-streamers-table'
import { YoutubeChannelsPanel } from '../_components/youtube-channels-panel'
import { YoutubeChannelsTable } from '../_components/youtube-channels-table'
import { XCreatorsPanel } from '../_components/x-creators-panel'
import { XCreatorsTable } from '../_components/x-creators-table'
import { FbAdvertisersPanel } from '../_components/fb-advertisers-panel'
import { FbAdvertisersTable } from '../_components/fb-advertisers-table'
import { TiktokCreatorsPanel } from '../_components/tiktok-creators-panel'
import { TiktokCreatorsTable } from '../_components/tiktok-creators-table'
import { SnapchatCreatorsPanel } from '../_components/snapchat-creators-panel'
import { SnapchatCreatorsTable } from '../_components/snapchat-creators-table'
import { TelegramChannelsPanel } from '../_components/telegram-channels-panel'
import { TelegramChannelsTable } from '../_components/telegram-channels-table'
import {
  fetchFbAdvertiserRows,
  fetchFbAdvertiserSummary,
  fetchKickStreamerRows,
  fetchKickStreamerSummary,
  fetchStageSummary,
  fetchXCreatorRows,
  fetchXCreatorSummary,
  fetchTiktokCreatorRows,
  fetchTiktokCreatorSummary,
  fetchSnapchatCreatorRows,
  fetchSnapchatCreatorSummary,
  fetchTelegramChannelRows,
  fetchTelegramChannelSummary,
  fetchYoutubeChannelRows,
  fetchYoutubeChannelSummary,
} from '../_lib/queries'

type SearchParams = Record<string, string | string[] | undefined>

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<SearchParams>
}

type Job = {
  id: string
  keyword: string
  keyword_en: string | null
  country_code: string
  pages: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha' | 'paused' | 'cancelled'
  attempts: number
  batch_id: number | null
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | 'facebook' | 'tiktok' | 'snapchat' | 'telegram' | null
  view_mode: 'desktop' | 'mobile' | 'both' | null
  language: string | null
  created_at: string
}

const STATUS_STYLES: Record<Job['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
  paused: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
}

export const dynamic = 'force-dynamic'
// The YouTube "Score & check" action (runYoutubeChannelAnalysis) runs inline
// from this route and does bounded HTTP work — shortener follows + a two-hop
// fetch of each likely affiliate's landing page to mine S-tags. Give it room
// past the default serverless timeout (mirrors the Monday sync routes).
export const maxDuration = 300

async function countNotRelevantInJob(
  svc: ReturnType<typeof createServiceClient>,
  jobId: string,
): Promise<number> {
  const { count } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .eq('scrape_job_id', jobId)
    .eq('is_not_relevant', true)
  return count ?? 0
}

export default async function ScrapeJobPage({ params, searchParams }: Props) {
  const { id } = await params
  const sp = await searchParams

  const svc = createServiceClient()
  const { data: jobRaw, error: jobError } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, keyword_en, country_code, pages, status, attempts, batch_id, claimed_by, started_at, completed_at, error_message, result_summary, search_engine, view_mode, language, created_at, created_by_is_shadow, created_by_email',
    )
    .eq('id', id)
    .maybeSingle()
  if (jobError) {
    // PostgrestError doesn't survive Next's error-overlay serializer
    // (logs render as `{}`), so pull the useful fields out by hand.
    console.error('[scrape/[id]]', {
      message: jobError.message,
      details: jobError.details,
      hint: jobError.hint,
      code: jobError.code,
    })
    throw new Error(`Failed to load job: ${jobError.message}`)
  }
  if (!jobRaw) notFound()

  // Shadow-isolation gate. Direct URL access to a job belonging to a
  // shadow user (or vice versa) is treated as not-found so we never
  // leak even an existence signal.
  const gate = jobRaw as { created_by_is_shadow?: boolean | null; created_by_email?: string | null }
  const shadowCtx = await getShadowContext()
  const targetIsShadow = gate.created_by_is_shadow === true
  const targetEmail = (gate.created_by_email ?? '').toLowerCase()
  const allowed = shadowCtx.isShadow
    ? targetEmail === (shadowCtx.email ?? '')
    : !targetIsShadow
  if (!allowed) notFound()

  const job = jobRaw as Job

  // Lazy backfill: jobs queued before the translation feature shipped
  // have keyword_en = null. Translate on first non-English view and
  // persist so subsequent visits don't re-hit the API. Failure is
  // silent — page just renders without the translation.
  if (job.keyword_en === null && job.language && job.language !== 'en') {
    const translations = await translateKeywordsToEnglish([job.keyword], job.language)
    const translated = translations.get(job.keyword) ?? null
    if (translated) {
      job.keyword_en = translated
      await svc
        .from('scrape_queue')
        .update({ keyword_en: translated })
        .eq('id', job.id)
    }
  }

  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, LEAD_PAGE_SIZES, DEFAULT_LEAD_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : 'overall_position'
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const q = typeof sp.q === 'string' ? sp.q : ''
  const countryCode = typeof sp.country_code === 'string' ? sp.country_code : ''
  const resultType = typeof sp.result_type === 'string' ? sp.result_type : ''
  const filters = parseFilters(sp.f)
  const sorts = parseSorts(sp.s)
  // Default: hide rows flagged is_not_relevant — which now includes
  // Monday duplicates (existing), manual user flags (existing), AND
  // casino-operator domains auto-flagged at enrichment time
  // (20260528200000_operator_denylist.sql). `?show_hidden=1` shows
  // every row. Mirrors the /leads toggle so the UX is consistent.
  const showHidden = sp.show_hidden === '1'

  // The mobile-skipped retry banner needs the Captcha solver flag so it
  // can warn the operator when the solver is off (a mobile-only retry on
  // a captcha-trippy keyword will just abort again). Fetched here so the
  // banner stays a client component without its own RSC fetch.
  const mobileCaptchaAborted =
    job.view_mode === 'both' &&
    job.result_summary?.['mobile_pass_skipped'] === 'captcha'

  const isKick = job.search_engine === 'kick'
  const isYoutube = job.search_engine === 'youtube'
  const isX = job.search_engine === 'x'
  const isFacebook = job.search_engine === 'facebook'
  const isTiktok = job.search_engine === 'tiktok'
  const isSnapchat = job.search_engine === 'snapchat'
  const isTelegram = job.search_engine === 'telegram'
  // Kick / YouTube / X / Facebook / TikTok / Snapchat / Telegram all live in
  // their own tables/panels — none produces leads, so the lead filters + table
  // + enrichment stages don't apply.
  const noLeadsEngine = isKick || isYoutube || isX || isFacebook || isTiktok || isSnapchat || isTelegram

  const [
    { rows, total },
    hiddenCount,
    stageSummary,
    captchaSolverEnabled,
    kickSummary,
    kickRows,
    youtubeSummary,
    youtubeRows,
    xSummary,
    xRows,
    fbSummary,
    fbRows,
    tiktokSummary,
    tiktokRows,
    snapchatSummary,
    snapchatRows,
    telegramSummary,
    telegramRows,
  ] = await Promise.all([
      queryLeads({
        page,
        size,
        sort,
        order,
        q,
        countryCode,
        resultType,
        scrapeJobId: id,
        filters,
        sorts,
        includeNotRelevant: showHidden,
      }),
      countNotRelevantInJob(svc, id),
      // Kick / YouTube jobs have no leads, so the lead-enrichment stages don't apply.
      noLeadsEngine ? Promise.resolve(null) : fetchStageSummary(id),
      mobileCaptchaAborted
        ? svc
            .rpc('get_system_setting', { p_key: 'captcha_solver_enabled' })
            .then(({ data }) => data !== false)
        : Promise.resolve(true),
      isKick ? fetchKickStreamerSummary(id) : Promise.resolve(null),
      isKick ? fetchKickStreamerRows(id) : Promise.resolve(null),
      isYoutube ? fetchYoutubeChannelSummary(id) : Promise.resolve(null),
      isYoutube ? fetchYoutubeChannelRows(id) : Promise.resolve(null),
      isX ? fetchXCreatorSummary(id) : Promise.resolve(null),
      isX ? fetchXCreatorRows(id) : Promise.resolve(null),
      isFacebook ? fetchFbAdvertiserSummary(id) : Promise.resolve(null),
      isFacebook ? fetchFbAdvertiserRows(id) : Promise.resolve(null),
      isTiktok ? fetchTiktokCreatorSummary(id) : Promise.resolve(null),
      isTiktok ? fetchTiktokCreatorRows(id) : Promise.resolve(null),
      isSnapchat ? fetchSnapchatCreatorSummary(id) : Promise.resolve(null),
      isSnapchat ? fetchSnapchatCreatorRows(id) : Promise.resolve(null),
      isTelegram ? fetchTelegramChannelSummary(id) : Promise.resolve(null),
      isTelegram ? fetchTelegramChannelRows(id) : Promise.resolve(null),
    ])

  const toggleHref = (() => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'show_hidden' || k === 'page') continue
      if (typeof v === 'string') next.set(k, v)
      else if (Array.isArray(v)) for (const item of v) next.append(k, item)
    }
    if (!showHidden) next.set('show_hidden', '1')
    const qs = next.toString()
    return qs ? `/scrape/${id}?${qs}` : `/scrape/${id}`
  })()

  // Country and batch are constant for one job, so drop them from the
  // filter dropdowns; URL is constant so omitting them keeps the picker tidy.
  const columns = LEADS_COLUMNS.filter(
    c => c.key !== 'country_code' && c.key !== 'batch_id',
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/scrape"
          className="inline-flex w-fit items-center gap-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Scrape
        </Link>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold text-[color:var(--color-text-primary)]">
              <span className="truncate">{job.keyword}</span>
              <EngineBadge engine={job.search_engine} />
              <ViewModeBadge mode={job.view_mode} />
            </h1>
            {job.keyword_en && (
              <p
                className="mt-0.5 text-[13px] italic text-[color:var(--color-text-secondary)]"
                title={`English translation of "${job.keyword}"`}
              >
                English: {job.keyword_en}
              </p>
            )}
            <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
              {job.country_code} · {job.pages} page{job.pages === 1 ? '' : 's'}
              {job.language && job.language !== 'en' && <> · lang {job.language}</>}
              {job.batch_id !== null && <> · batch {job.batch_id}</>}
              {' · '}
              <span className="text-[color:var(--color-text-primary)]">
                {total.toLocaleString()}
              </span>
              {' '}row{total === 1 ? '' : 's'}
              {!showHidden && hiddenCount > 0 && (
                <span className="ml-1">
                  · {hiddenCount.toLocaleString()} hidden as not relevant
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {(showHidden || hiddenCount > 0) && (
              <Link
                href={toggleHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
                title={
                  showHidden
                    ? 'Hide rows marked as not relevant'
                    : 'Include rows marked as not relevant (operators, Monday duplicates, manual flags) in the table below'
                }
              >
                {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showHidden ? 'Hide not-relevant' : `Show not-relevant (${hiddenCount})`}
              </Link>
            )}
            <span
              className={[
                'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
                STATUS_STYLES[job.status],
              ].join(' ')}
            >
              {job.status}
            </span>
          </div>
        </div>
      </header>

      <JobMeta job={job} />

      {job.status === 'captcha' && (
        <CaptchaRecoveryBanner jobId={job.id} errorMessage={job.error_message} />
      )}

      {mobileCaptchaAborted && (
        <MobileSkippedRetryBanner
          jobId={job.id}
          captchaSolverEnabled={captchaSolverEnabled}
        />
      )}

      {isKick ? (
        <>
          {kickSummary && <KickStreamersPanel jobId={job.id} summary={kickSummary} />}
          {kickRows && kickRows.length > 0 && <KickStreamersTable rows={kickRows} />}
        </>
      ) : isYoutube ? (
        <>
          {youtubeSummary && <YoutubeChannelsPanel jobId={job.id} summary={youtubeSummary} />}
          {youtubeRows && youtubeRows.length > 0 && <YoutubeChannelsTable rows={youtubeRows} />}
        </>
      ) : isX ? (
        <>
          {xSummary && <XCreatorsPanel jobId={job.id} summary={xSummary} />}
          {xRows && xRows.length > 0 && <XCreatorsTable rows={xRows} />}
        </>
      ) : isFacebook ? (
        <>
          {fbSummary && <FbAdvertisersPanel jobId={job.id} summary={fbSummary} />}
          {fbRows && fbRows.length > 0 && <FbAdvertisersTable rows={fbRows} />}
        </>
      ) : isTiktok ? (
        <>
          {tiktokSummary && <TiktokCreatorsPanel jobId={job.id} summary={tiktokSummary} />}
          {tiktokRows && tiktokRows.length > 0 && <TiktokCreatorsTable rows={tiktokRows} />}
        </>
      ) : isSnapchat ? (
        <>
          {snapchatSummary && <SnapchatCreatorsPanel jobId={job.id} summary={snapchatSummary} />}
          {snapchatRows && snapchatRows.length > 0 && <SnapchatCreatorsTable rows={snapchatRows} />}
        </>
      ) : isTelegram ? (
        <>
          {telegramSummary && <TelegramChannelsPanel jobId={job.id} summary={telegramSummary} />}
          {telegramRows && telegramRows.length > 0 && <TelegramChannelsTable rows={telegramRows} />}
        </>
      ) : (
        stageSummary && <EnrichmentStages jobId={job.id} summary={stageSummary} />
      )}

      {/* Kick / YouTube jobs have no leads (streamers/channels live in the
          panel/table above), so the lead filters + table + pagination would
          just render an empty "No rows" block — hide them for those engines. */}
      {!noLeadsEngine && (
        <>
          <div className="pt-2">
            <AdvancedFilters columns={columns} preserve={['show_hidden']} />
          </div>

          <LeadsTable rows={rows} jobContext pageInfo={{ page, size, total }} />

          <Pagination page={page} size={size} total={total} pageSizeOptions={LEAD_PAGE_SIZES} />
        </>
      )}

      <AutoRefresh
        enabled={
          job.status === 'pending' ||
          job.status === 'running' ||
          // Kick / YouTube Phase-2 enrichment runs as its own scrape_queue
          // job — keep refreshing while it's queued/running so counts update live.
          kickSummary?.inflight === true ||
          youtubeSummary?.inflight === true ||
          xSummary?.inflight === true ||
          tiktokSummary?.inflight === true ||
          (stageSummary != null &&
            (stageSummary.affiliate.inflight_pending + stageSummary.affiliate.inflight_running > 0 ||
              stageSummary.rooster.inflight_pending + stageSummary.rooster.inflight_running > 0 ||
              stageSummary.contact.inflight_pending + stageSummary.contact.inflight_running > 0 ||
              stageSummary.stag.inflight_pending + stageSummary.stag.inflight_running > 0))
        }
      />
    </div>
  )
}

function EngineBadge({ engine }: { engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | 'facebook' | 'tiktok' | 'snapchat' | 'telegram' | null }) {
  const e = engine ?? 'google'
  const styles =
    e === 'bing'
      ? 'bg-cyan-100 text-cyan-800'
      : e === 'youtube'
        ? 'bg-red-100 text-red-800'
        : e === 'twitch'
          ? 'bg-purple-100 text-purple-800'
          : e === 'kick'
            ? 'bg-green-100 text-green-800'
            : e === 'x'
              ? 'bg-slate-200 text-slate-900'
              : e === 'facebook'
                ? 'bg-indigo-100 text-indigo-800'
                : e === 'tiktok'
                  ? 'bg-pink-100 text-pink-800'
                  : e === 'snapchat'
                    ? 'bg-yellow-100 text-yellow-800'
                    : e === 'telegram'
                      ? 'bg-sky-100 text-sky-800'
                      : 'bg-blue-100 text-blue-800'
  const label = e === 'youtube' ? 'YouTube' : e === 'bing' ? 'Bing' : e === 'twitch' ? 'Twitch' : e === 'kick' ? 'Kick' : e === 'x' ? 'X' : e === 'facebook' ? 'Facebook' : e === 'tiktok' ? 'TikTok' : e === 'snapchat' ? 'Snapchat' : e === 'telegram' ? 'Telegram' : 'Google'
  return (
    <span
      title={`Scraped on ${label}`}
      className={[
        'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        styles,
      ].join(' ')}
    >
      {label}
    </span>
  )
}

function ViewModeBadge({ mode }: { mode: 'desktop' | 'mobile' | 'both' | null }) {
  const m = mode ?? 'both'
  const style =
    m === 'mobile'
      ? 'border-violet-400 text-violet-700'
      : m === 'both'
        ? 'border-orange-400 text-orange-700'
        : 'border-slate-400 text-slate-600'
  const title =
    m === 'mobile'
      ? 'Mobile pass only — iPhone UA + 375x812 viewport.'
      : m === 'both'
        ? 'Desktop pass then mobile pass — catches mobile-only PPC and mobile-ranked organic.'
        : 'Desktop pass only.'
  return (
    <span
      title={title}
      className={[
        'inline-block rounded-full border bg-transparent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        style,
      ].join(' ')}
    >
      {m}
    </span>
  )
}

function JobMeta({ job }: { job: Job }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: 'Job ID', value: job.id },
    { label: 'Worker', value: job.claimed_by },
    { label: 'Started', value: formatTs(job.started_at) },
    { label: 'Completed', value: formatTs(job.completed_at) },
    { label: 'Duration', value: formatDuration(job.started_at, job.completed_at) },
    { label: 'Attempts', value: String(job.attempts) },
  ].filter(f => f.value)

  const mobileSkipped = mobilePassSkippedReason(job.result_summary)
  const mobileRequested = job.view_mode === 'mobile' || job.view_mode === 'both'

  return (
    <dl className="grid gap-x-4 gap-y-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 text-[11px] md:grid-cols-[auto_1fr_auto_1fr_auto_1fr]">
      {fields.map(f => (
        <div key={f.label} className="contents">
          <dt className="text-[color:var(--color-text-secondary)]">{f.label}</dt>
          <dd className="truncate text-[color:var(--color-text-primary)]" title={f.value ?? undefined}>
            {f.value}
          </dd>
        </div>
      ))}
      {mobileRequested && mobileSkipped && mobileSkipped !== 'captcha' && (
        <div className="col-span-full mt-1 rounded-md bg-amber-50 px-3 py-2 text-amber-800">
          <span className="font-medium">Mobile pass skipped:</span>{' '}
          {mobileSkippedExplanation(mobileSkipped)}
        </div>
      )}
      {job.error_message && job.status !== 'captcha' && (
        <div className="col-span-full mt-1 rounded-md bg-red-50 px-3 py-2 text-red-700">
          <span className="font-medium">Error:</span> {job.error_message}
        </div>
      )}
    </dl>
  )
}

function mobilePassSkippedReason(
  summary: Record<string, unknown> | null,
): string | null {
  if (!summary) return null
  const v = summary['mobile_pass_skipped']
  return typeof v === 'string' && v.length > 0 ? v : null
}

function mobileSkippedExplanation(reason: string): string {
  if (reason === 'viewport_setup_failed') {
    return 'mobile viewport setup failed on the worker (CDP override), so the mobile SERP pass never ran. Per-row View tags will show only "desktop" — and mobile-only jobs will return 0 rows. Needs a worker-side fix (vm/scraper.py _set_mobile_viewport).'
  }
  if (reason === 'parse_failed') {
    return 'mobile pass ran without captcha but the parser found 0 rows on every page — most likely the SERP DOM didn’t match our selectors (mobile Google ships a different result container from desktop). Every row is tagged seen_on="desktop" and no mobile-only / cross-device counts are available. Needs a worker-side fix (vm/scraper.py get_google_results_selenium).'
  }
  if (reason === 'captcha') {
    return 'mobile pass aborted on captcha (silent abort to preserve desktop results). Per-row View tags will show only "desktop" for this job.'
  }
  return reason
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null
  const start = new Date(startedAt).getTime()
  const end = new Date(completedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function clampInt(
  raw: string | string[] | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function clampEnum<T extends number>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback
}
