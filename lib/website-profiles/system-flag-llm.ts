import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * OpenAI pass for the website "system flag".
 *
 * A website that is obviously not a gambling affiliate (a video platform, a
 * newspaper, a regulator, the casino operator itself) should never reach the
 * affiliate / Rooster crawl. The own-DB pass (`apply_db_system_flags`) covers
 * the lists we maintain; this pass asks a small OpenAI model about the rest,
 * a few new websites per scheduler tick, and only flags when the model is
 * confident. Gated by the `system_flag_llm_enabled` setting and needs an
 * OpenAI key (integration setting `openai_api_key`, or env OPENAI_API_KEY /
 * OPENAI_APIKEY).
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
const MODEL = 'gpt-4o-mini'

const ALLOWED_CATEGORIES = new Set([
  'platform',
  'search_engine',
  'social_platform',
  'news',
  'reference',
  'government',
  'regulator',
  'responsible_gambling',
  'payment',
  'tool',
  'operator_site',
  'other_non_affiliate',
])

const SYSTEM_PROMPT = `You classify websites for a team that hunts online-casino AFFILIATE sites (review listicles, "best casinos" comparison pages, bonus aggregators, streamers' link pages — anything whose business is sending players to casino brands for commission).

Given a domain and a few of the Google/Bing keywords it appeared for, decide ONLY whether the site is OBVIOUSLY NOT an affiliate. Obvious non-affiliates: global platforms (video, social, app stores, search engines, encyclopedias), newspapers and mainstream media, government bodies and gambling regulators, responsible-gambling charities, payment providers, software tools, and the casino/sportsbook OPERATOR itself (a site where you register, deposit and play).

If there is any real chance the site is an affiliate, or you simply do not recognise it, answer false. Never guess from the name alone unless the name is a household brand.

Reply with strict JSON: {"obvious_non_affiliate": boolean, "category": one of ["platform","search_engine","social_platform","news","reference","government","regulator","responsible_gambling","payment","tool","operator_site","other_non_affiliate"] or null, "reason": short sentence}`

type Candidate = { id: number; normalized_domain: string; display_name: string | null; keywords: string[] }

type Verdict = { obvious_non_affiliate: boolean; category: string | null; reason: string }

export type SystemFlagLlmResult = {
  checked: number
  flagged: number
  skipped?: string
  errors?: string[]
}

async function readOpenAiKey(svc: SupabaseClient): Promise<string | null> {
  const { data } = await svc.rpc('get_system_setting', { p_key: 'openai_api_key' })
  const fromDb = typeof data === 'string' ? data.trim() : ''
  if (fromDb) return fromDb
  const fromEnv = (process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY ?? '').trim()
  return fromEnv || null
}

async function classify(key: string, c: Candidate, timeoutMs: number): Promise<Verdict | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const user = [
      `Domain: ${c.normalized_domain}`,
      c.display_name && c.display_name !== c.normalized_domain ? `Known as: ${c.display_name}` : null,
      c.keywords.length ? `Appeared for keywords: ${c.keywords.slice(0, 5).join(' | ')}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) return null
    const parsed = JSON.parse(content) as Partial<Verdict>
    return {
      obvious_non_affiliate: parsed.obvious_non_affiliate === true,
      category: typeof parsed.category === 'string' ? parsed.category : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Classify up to `limit` never-judged websites. Safe to call every minute:
 * it returns immediately when the setting is off or no key is configured.
 */
export async function runSystemFlagLlmPass(
  svc: SupabaseClient,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<SystemFlagLlmResult> {
  const limit = opts.limit ?? 5
  const timeoutMs = opts.timeoutMs ?? 6_000

  const { data: enabledRaw } = await svc.rpc('get_system_setting', { p_key: 'system_flag_llm_enabled' })
  if (enabledRaw !== true) return { checked: 0, flagged: 0, skipped: 'system_flag_llm_enabled is off' }

  const key = await readOpenAiKey(svc)
  if (!key) return { checked: 0, flagged: 0, skipped: 'no OpenAI key configured' }

  const { data: rows, error } = await svc
    .from('website_profiles')
    .select('id, normalized_domain, display_name')
    .is('system_flag', null)
    .is('system_flag_llm_checked_at', null)
    .is('system_flag_overridden_at', null)
    .eq('is_on_monday', false)
    .eq('is_not_relevant', false)
    .eq('source', 'scrape')
    .not('system_flag_checked_at', 'is', null) // the DB pass ran first
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return { checked: 0, flagged: 0, errors: [error.message] }

  const cands = (rows ?? []) as Array<Omit<Candidate, 'keywords'>>
  if (cands.length === 0) return { checked: 0, flagged: 0 }

  const { data: apps } = await svc
    .from('website_appearances')
    .select('profile_id, keyword')
    .in('profile_id', cands.map(c => c.id))
    .order('seen_at', { ascending: false })
    .limit(cands.length * 6)
  const kwBy = new Map<number, string[]>()
  for (const a of (apps ?? []) as Array<{ profile_id: number; keyword: string | null }>) {
    if (!a.keyword) continue
    const list = kwBy.get(a.profile_id) ?? []
    if (!list.includes(a.keyword)) list.push(a.keyword)
    kwBy.set(a.profile_id, list)
  }

  const errors: string[] = []
  let flagged = 0
  const now = new Date().toISOString()

  await Promise.all(
    cands.map(async c => {
      const verdict = await classify(key, { ...c, keywords: kwBy.get(c.id) ?? [] }, timeoutMs)
      if (verdict && verdict.obvious_non_affiliate && verdict.category && ALLOWED_CATEGORIES.has(verdict.category)) {
        const { error: rpcErr } = await svc.rpc('set_profile_system_flag', {
          p_profile_id: c.id,
          p_flag: verdict.category,
          p_source: 'openai',
          p_reason: verdict.reason || `OpenAI: obvious non-affiliate (${verdict.category})`,
        })
        if (rpcErr) errors.push(`${c.normalized_domain}: ${rpcErr.message}`)
        else flagged += 1
        return
      }
      // Judged (or unreachable) — stamp so we do not ask again. An API failure
      // is stamped too: the next scrape appearance is what matters, and an
      // operator can clear the stamp from the profile if needed.
      const { error: updErr } = await svc
        .from('website_profiles')
        .update({ system_flag_llm_checked_at: now })
        .eq('id', c.id)
      if (updErr) errors.push(`${c.normalized_domain}: ${updErr.message}`)
    }),
  )

  return { checked: cands.length, flagged, ...(errors.length ? { errors } : {}) }
}
