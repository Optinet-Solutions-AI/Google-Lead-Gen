import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Advanced search for the scrape list.
 *
 * The old search was one `ilike %term%` OR'd across five columns, so it only
 * ever found a literal substring: "norway casino" matched nothing unless
 * those words sat next to each other in one field, "failed" matched nothing
 * at all because status was not searched, and a batch could not be found by
 * the domain it produced.
 *
 * This splits the query into words and requires every word to match
 * SOMEWHERE on the row — order-independent, and each word may land in a
 * different column. PostgREST ANDs repeated `or=` parameters, so one `.or()`
 * per word gives exactly that.
 *
 * Each word is also expanded before matching:
 *   - a country NAME resolves to its code      "norway"      -> country_code NO
 *   - status / engine / source words and their
 *     everyday synonyms                        "done"        -> status completed
 *                                              "ads"         -> result_type PPC
 *   - a number matches the batch                "4653"        -> batch_id
 *   - something domain-shaped matches the jobs
 *     that produced that lead                  "mrvegas.com" -> its scrape jobs
 *   - English translations are searched too, so an English word finds a
 *     German or Norwegian keyword (keyword_en is populated for ~1.5k rows)
 */

/** Columns a plain word is matched against. */
const TEXT_COLUMNS = [
  'keyword',
  'keyword_en',
  'country_code',
  'status',
  'search_engine',
  'scrape_source',
  'enrichment_status',
  'language',
  'view_mode',
  'error_message',
  'created_by_display',
  'created_by_username',
] as const

/** Everyday words for values that are stored as short codes. */
const SYNONYMS: Record<string, Array<{ column: string; value: string }>> = {
  done: [{ column: 'status', value: 'completed' }],
  complete: [{ column: 'status', value: 'completed' }],
  finished: [{ column: 'status', value: 'completed' }],
  error: [{ column: 'status', value: 'failed' }],
  broken: [{ column: 'status', value: 'failed' }],
  waiting: [{ column: 'status', value: 'pending' }],
  queued: [{ column: 'status', value: 'pending' }],
  running: [{ column: 'status', value: 'running' }],
  stopped: [{ column: 'status', value: 'cancelled' }],
  ads: [{ column: 'result_type_filter', value: 'PPC' }],
  ppc: [{ column: 'result_type_filter', value: 'PPC' }],
  paid: [{ column: 'result_type_filter', value: 'PPC' }],
  organic: [{ column: 'result_type_filter', value: 'Organic' }],
  desktop: [{ column: 'view_mode', value: 'desktop' }],
  mobile: [{ column: 'view_mode', value: 'mobile' }],
  enriched: [{ column: 'enrichment_status', value: 'complete' }],
  rerun: [{ column: 'is_rerun', value: 'true' }],
  scheduled: [{ column: 'scrape_source', value: 'apify' }],
}

/** PostgREST filter values break on these. */
const sanitize = (s: string) => s.replace(/[,()*"']/g, ' ').trim()

const isDomainLike = (t: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)

export type SearchPlan = {
  /** One PostgREST `or=` group per word; the caller ANDs them. */
  groups: string[]
  /** What the search understood, for showing back to the person. */
  notes: string[]
}

/**
 * Turn a free-text query into PostgREST OR groups. Returns null when the
 * query has nothing usable in it.
 */
export async function buildJobSearch(
  svc: SupabaseClient,
  raw: string,
): Promise<SearchPlan | null> {
  const tokens = raw
    .split(/\s+/)
    .map(t => sanitize(t))
    .filter(t => t.length > 0)
  if (tokens.length === 0) return null

  // Country names -> codes. Only 19 rows, and it makes "norway" work.
  const { data: profileRows } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
  const countries = ((profileRows ?? []) as Array<{ country_code: string; country_name: string | null }>)
    .map(p => ({ code: p.country_code, name: (p.country_name ?? '').toLowerCase() }))

  const groups: string[] = []
  const notes: string[] = []

  for (const token of tokens) {
    const lower = token.toLowerCase()
    const conditions: string[] = TEXT_COLUMNS.map(c => `${c}.ilike.*${token}*`)

    // country name -> code
    for (const c of countries) {
      if (c.name && (c.name === lower || c.name.startsWith(lower)) && lower.length >= 3) {
        conditions.push(`country_code.eq.${c.code}`)
        notes.push(`“${token}” → country ${c.code}`)
        break
      }
    }

    // everyday synonym -> stored value
    for (const s of SYNONYMS[lower] ?? []) {
      conditions.push(`${s.column}.eq.${s.value}`)
      notes.push(`“${token}” → ${s.column.replace(/_/g, ' ')} ${s.value}`)
    }

    // a number is almost always a batch
    if (/^\d+$/.test(token)) {
      conditions.push(`batch_id.eq.${token}`)
      notes.push(`“${token}” → batch number`)
    }

    // a domain -> the jobs whose leads include it
    if (isDomainLike(token)) {
      const { data: leadRows } = await svc
        .from('google_lead_gen_table')
        .select('scrape_job_id')
        .ilike('domain', `%${token}%`)
        .not('scrape_job_id', 'is', null)
        .limit(200)
      const ids = [
        ...new Set(((leadRows ?? []) as Array<{ scrape_job_id: string | null }>)
          .map(r => r.scrape_job_id)
          .filter((v): v is string => Boolean(v))),
      ]
      if (ids.length > 0) {
        conditions.push(`id.in.(${ids.join(',')})`)
        notes.push(`“${token}” → ${ids.length} batch${ids.length === 1 ? '' : 'es'} that found this website`)
      }
    }

    groups.push(conditions.join(','))
  }

  return { groups, notes: [...new Set(notes)] }
}
