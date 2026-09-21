import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callOpenAI, costOf, type Usage } from './core'

/**
 * Is this search result actually relevant to the keyword that found it?
 *
 * Judging only "is it an affiliate?" lets through porn sites, YouTube links
 * and social profiles that look commercial enough to pass. A result has to
 * be relevant to the KEYWORD, and Google already tells us what each result
 * is: the title and the snippet.
 *
 * Runs before the affiliate work and gates it — an irrelevant result is
 * never opened, never crawled, never charged for. An operator can override
 * a rejection and force the enrichment through.
 *
 * Cheap by design: no page fetch, one small call per batch of results, and
 * it reads what the SERP already gave us.
 */

const RELEVANCE_INSTRUCTIONS = [
  'You are screening search results for a team that finds online-casino and sports-betting AFFILIATE websites.',
  '',
  'For each numbered result you get the KEYWORD that was searched, the result TITLE, its SNIPPET and its DOMAIN. Decide whether the result is a plausible lead for that keyword — i.e. a website in the online gambling space that could be an affiliate, a comparison site, a review site, a streamer/influencer page promoting casinos, or an operator.',
  '',
  'Mark relevant = false for anything the keyword clearly did not intend, even when it looks commercial:',
  '  - pornography or adult content',
  '  - a video, post or channel on YouTube, TikTok, Facebook, Instagram, X, Reddit or similar',
  '  - news articles, encyclopedias, dictionaries, academic or government pages',
  '  - shops, jobs, real estate, travel and other unrelated businesses',
  '  - pages about a DIFFERENT subject that merely share a word with the keyword',
  '',
  'Also give a short description: what the website IS, in at most 12 words, plainly ("Norwegian casino review and bonus comparison site"). Describe the site, not the page.',
  '',
  'Be decisive. If the title and snippet genuinely do not say enough, mark relevant = true and say so in the reason — a wrong rejection costs a lead, a wrong acceptance only costs a fraction of a cent.',
  '',
  'Reply with strict JSON: {"results":[{"n":1,"relevant":true,"reason":"...","description":"..."}]} with one entry per numbered result.',
].join('\n')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n: { type: 'integer' },
          relevant: { type: 'boolean' },
          reason: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['n', 'relevant', 'reason', 'description'],
      },
    },
  },
  required: ['results'],
}

export type RelevanceCandidate = {
  lead_id: number
  profile_id: number | null
  keyword: string | null
  serp_title: string | null
  serp_description: string | null
  domain: string | null
}

export type RelevanceVerdict = {
  lead_id: number
  relevant: boolean
  reason: string
  description: string
}

export type RelevanceRunResult = {
  checked: number
  relevant: number
  rejected: number
  costUsd: number
  errors?: string[]
}

/** One call covers a page of results — they share a keyword and the model
 *  judges them as a set, which is both cheaper and more consistent. */
export async function judgeRelevance(
  key: string,
  model: string,
  batch: RelevanceCandidate[],
): Promise<{ verdicts: RelevanceVerdict[]; usage: Usage; cost: number; error?: string }> {
  const lines = batch.map((c, i) =>
    [
      `#${i + 1}`,
      `KEYWORD: ${c.keyword ?? '(unknown)'}`,
      `DOMAIN: ${c.domain ?? '(unknown)'}`,
      `TITLE: ${c.serp_title ?? '(none)'}`,
      `SNIPPET: ${c.serp_description ?? '(none)'}`,
    ].join('\n'),
  )

  const body: Record<string, unknown> = {
    model,
    instructions: RELEVANCE_INSTRUCTIONS,
    input: lines.join('\n\n'),
    text: { format: { type: 'json_schema', name: 'relevance', strict: true, schema: SCHEMA } },
  }
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning = { effort: 'low' }

  const res = await callOpenAI(key, body, 120_000)
  const parsed = res.parsed as { results?: Array<{ n: number; relevant: boolean; reason: string; description: string }> } | null
  if (!parsed?.results) {
    return {
      verdicts: [],
      usage: res.usage,
      cost: costOf(res.usage),
      error: res.ok ? 'no verdicts parsed' : `HTTP ${res.status}`,
    }
  }

  const verdicts: RelevanceVerdict[] = []
  for (const r of parsed.results) {
    const c = batch[r.n - 1]
    if (!c) continue
    verdicts.push({
      lead_id: c.lead_id,
      relevant: r.relevant !== false,
      reason: (r.reason ?? '').slice(0, 300),
      description: (r.description ?? '').slice(0, 200),
    })
  }
  return { verdicts, usage: res.usage, cost: costOf(res.usage) }
}

/**
 * Judge the unchecked results of one or more scrape jobs and save the
 * verdicts. Returns what it did so the caller can report it.
 */
export async function runRelevanceForJobs(
  svc: SupabaseClient,
  key: string,
  model: string,
  jobIds: string[],
  opts: { limit?: number; batchSize?: number; concurrency?: number } = {},
): Promise<RelevanceRunResult> {
  const limit = opts.limit ?? 200
  const batchSize = opts.batchSize ?? 20
  const errors: string[] = []

  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select('id, profile_id, keyword, serp_title, serp_description, domain')
    .in('scrape_job_id', jobIds)
    .is('is_relevant', null)
    .is('relevance_overridden_at', null)
    .order('overall_position', { ascending: true })
    .limit(limit)
  if (error) return { checked: 0, relevant: 0, rejected: 0, costUsd: 0, errors: [error.message] }

  const candidates = ((data ?? []) as Array<{
    id: number; profile_id: number | null; keyword: string | null
    serp_title: string | null; serp_description: string | null; domain: string | null
  }>).map(r => ({
    lead_id: r.id,
    profile_id: r.profile_id,
    keyword: r.keyword,
    serp_title: r.serp_title,
    serp_description: r.serp_description,
    domain: r.domain,
  }))
  if (candidates.length === 0) return { checked: 0, relevant: 0, rejected: 0, costUsd: 0 }

  let cost = 0
  let relevant = 0
  let rejected = 0
  const now = new Date().toISOString()

  const slices: RelevanceCandidate[][] = []
  for (let i = 0; i < candidates.length; i += batchSize) slices.push(candidates.slice(i, i + batchSize))

  // The batches are independent, so run a few at a time. Sequentially this
  // was ~17s per batch and minutes for a job; the cap keeps us well inside
  // OpenAI's rate limits while cutting the wall clock by ~5x.
  const concurrency = opts.concurrency ?? 5
  let next = 0
  const worker = async () => {
    for (;;) {
      const idx = next++
      const slice = slices[idx]
      if (!slice) return

      const { verdicts, cost: c, error: err } = await judgeRelevance(key, model, slice)
      cost += c
      if (err) { errors.push(err); continue }

      for (const v of verdicts) {
        if (v.relevant) relevant++
        else rejected++
        const { error: upErr } = await svc
          .from('google_lead_gen_table')
          .update({
            is_relevant: v.relevant,
            relevance_reason: v.reason,
            relevance_checked_at: now,
            relevance_source: model,
          })
          .eq('id', v.lead_id)
        if (upErr) errors.push(`lead ${v.lead_id}: ${upErr.message}`)
      }

      // The description is about the website, so it lives on the profile.
      for (const v of verdicts) {
        const c2 = slice.find(x => x.lead_id === v.lead_id)
        if (!c2?.profile_id || !v.description) continue
        await svc
          .from('website_profiles')
          .update({ ai_site_description: v.description })
          .eq('id', c2.profile_id)
          .is('ai_site_description', null)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, slices.length) }, worker))

  return {
    checked: relevant + rejected,
    relevant,
    rejected,
    costUsd: Number(cost.toFixed(5)),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
  }
}
