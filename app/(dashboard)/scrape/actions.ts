'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type EnqueueState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export type CheckMondayState =
  | { status: 'ok'; message: string; checked: number; matched: number }
  | { status: 'error'; error: string }
  | null

export async function checkMondayDuplicates(
  _prev: CheckMondayState,
  formData: FormData,
): Promise<CheckMondayState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const jobId = String(formData.get('job_id') ?? '').trim()
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('mark_monday_duplicates_for_job', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { checked: number; matched: number }
    | null
  const checked = row?.checked ?? 0
  const matched = row?.matched ?? 0

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    checked,
    matched,
    message:
      checked === 0
        ? 'No rows to check yet.'
        : matched === 0
          ? `Checked ${checked} row${checked === 1 ? '' : 's'} — none already on Monday.`
          : `Checked ${checked} row${checked === 1 ? '' : 's'} — ${matched} already on Monday.`,
  }
}

export async function enqueueScrape(
  _prev: EnqueueState,
  formData: FormData,
): Promise<EnqueueState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const rawKeywords = String(formData.get('keyword') ?? '')
  const country_code = String(formData.get('country_code') ?? '').trim().toUpperCase()
  const pages = clampInt(formData.get('pages'), 1, 10, 1)
  const priority = clampInt(formData.get('priority'), 0, 100, 0)

  // Parse the textarea — one keyword per line, trim whitespace,
  // dedupe exact duplicates, drop blanks.
  const keywords = Array.from(
    new Set(
      rawKeywords
        .split(/\r?\n/)
        .map(k => k.trim())
        .filter(k => k.length > 0),
    ),
  )

  if (keywords.length === 0) return { status: 'error', error: 'Enter at least one keyword.' }
  const tooLong = keywords.find(k => k.length > 500)
  if (tooLong) {
    return {
      status: 'error',
      error: `One of the keywords is too long (max 500 chars): "${tooLong.slice(0, 50)}…"`,
    }
  }
  if (!country_code) return { status: 'error', error: 'Pick a country.' }

  const svc = createServiceClient()

  // Verify the country has a configured GoLogin profile
  const { data: profile, error: profileError } = await svc
    .from('gologin_profiles')
    .select('country_code, is_active, gologin_profile_id')
    .eq('country_code', country_code)
    .maybeSingle()
  if (profileError) return { status: 'error', error: profileError.message }
  if (!profile) return { status: 'error', error: `Unknown country ${country_code}.` }
  if (!profile.is_active) return { status: 'error', error: `Country ${country_code} is disabled.` }
  if (!profile.gologin_profile_id) {
    return { status: 'error', error: `Country ${country_code} has no GoLogin profile configured.` }
  }

  const rows = keywords.map(keyword => ({ keyword, country_code, pages, priority }))
  const { error: insertError } = await svc.from('scrape_queue').insert(rows)
  if (insertError) return { status: 'error', error: insertError.message }

  revalidatePath('/scrape')
  return {
    status: 'ok',
    message:
      keywords.length === 1
        ? `Added "${keywords[0]}" to the queue for ${country_code}.`
        : `Added ${keywords.length} keywords to the queue for ${country_code}.`,
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}
