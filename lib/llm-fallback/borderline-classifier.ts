/**
 * LLM tie-breaker for borderline affiliate / rooster decisions.
 *
 * Heuristic-only classification works well at the extremes (HIGH /
 * VERY_HIGH confidence) but misses the middle of the distribution —
 * "review-style" sites that don't trip enough scoring patterns,
 * news-site casino paid placements, brand-name mentions hidden
 * behind cloaked tracking, etc.
 *
 * For LOW / MEDIUM affiliate confidence and cheap+deep rooster
 * misses, we ask GPT-4o-mini to look at the page text + the brand
 * list and make a final judgment. Returns null when OPENAI_API_KEY
 * isn't set or the call fails — the caller keeps the heuristic
 * verdict.
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
const MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 30_000
const MAX_TEXT_CHARS = 6000

// ---------------------------------------------------------------------------
// HTML → plain text helper. Crude but cheap; we don't need DOM accuracy.
// ---------------------------------------------------------------------------
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Strip again after entity decoding — an attacker can hide tags
    // as `&lt;script&gt;…&lt;/script&gt;` in the source HTML, which
    // survives the first pass and would otherwise resurrect as real
    // tags in the plain-text output.
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Affiliate borderline classifier
// ---------------------------------------------------------------------------

export type AffiliateBorderlineInput = {
  url: string
  html: string
  affiliateScore: number
  casinoScore: number
  externalCasinoLinks: number
  priorIndicators: string[]
}

export type AffiliateBorderlineResult = {
  isAffiliate: boolean
  reasoning: string
}

const AFFILIATE_PROMPT = `You are an analyst classifying websites in the online-casino affiliate space.

Given a website's visible text and some heuristic signals, decide whether the site is an AFFILIATE — i.e. its primary purpose is to drive traffic to other casino brands in exchange for commission (review listicles, "top 10 casinos" sites, bonus aggregators, comparison sites with outbound tracking links). Sites that are themselves casinos (login + deposit + withdrawal flows) are NOT affiliates.

Edge cases:
- Review aggregators like Trustpilot, Reddit threads, news sites running a paid casino placement → affiliate IF the page itself is structured as a casino review/comparison with outbound links/CTAs to brands. Otherwise not.
- Pure information / "how to gamble responsibly" content with no outbound brand promotion → not an affiliate.
- Casino brands' own marketing / partner pages → not an affiliate (it's the brand itself).

OUTPUT — strict JSON only:
{
  "is_affiliate": true | false,
  "reasoning": "1-2 sentence explanation grounded in the page text."
}`

export async function classifyAffiliateBorderline(
  input: AffiliateBorderlineInput,
): Promise<AffiliateBorderlineResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  const text = htmlToText(input.html).slice(0, MAX_TEXT_CHARS)
  if (text.length < 100) return null

  const userMsg = [
    `URL: ${input.url}`,
    `Heuristic scores: affiliate=${input.affiliateScore} · casino=${input.casinoScore} · outbound_casino_links=${input.externalCasinoLinks}`,
    input.priorIndicators.length > 0
      ? `Heuristic indicators: ${input.priorIndicators.slice(0, 8).join('; ')}`
      : '',
    '',
    'Page visible text (truncated):',
    text,
  ]
    .filter(Boolean)
    .join('\n')

  return callOpenAI<AffiliateBorderlineResult>(
    apiKey,
    AFFILIATE_PROMPT,
    userMsg,
    raw => {
      if (typeof raw !== 'object' || raw === null) return null
      const obj = raw as { is_affiliate?: unknown; reasoning?: unknown }
      if (typeof obj.is_affiliate !== 'boolean') return null
      return {
        isAffiliate: obj.is_affiliate,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Rooster borderline classifier
// ---------------------------------------------------------------------------

export type RoosterBorderlineInput = {
  url: string
  html: string
  brands: ReadonlyArray<{ domain: string; name: string | null }>
}

export type RoosterBorderlineResult = {
  isPartner: boolean
  matchedBrandDomains: string[]
  reasoning: string
}

const ROOSTER_PROMPT = `You are checking whether a casino-affiliate page promotes any of a given set of brands.

You'll receive (a) the page's visible text and (b) a numbered list of brands with their domains and display names. Decide whether the page mentions, links to, reviews, or otherwise promotes any of those brands.

A brand counts as "found" if you see ANY of:
- The brand domain (e.g. "spinjo.com") in the text or in a tracking-link context.
- The brand display name as a heading, button label, logo caption, or list entry — provided the context is clearly a casino promotion (not, say, the brand name appearing inside a paragraph that simply names many casinos).
- A "play at <Brand>" / "claim bonus at <Brand>" / "visit <Brand>" CTA.

Be conservative: a brand name appearing once inside a long competing-brand list with no special treatment is NOT promotion.

OUTPUT — strict JSON only:
{
  "is_partner": true | false,
  "matched_brand_domains": ["spinjo.com", ...],   // brand domains from the input list, never invented
  "reasoning": "1-2 sentence explanation."
}`

export async function classifyRoosterBorderline(
  input: RoosterBorderlineInput,
): Promise<RoosterBorderlineResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  if (input.brands.length === 0) return null

  const text = htmlToText(input.html).slice(0, MAX_TEXT_CHARS)
  if (text.length < 100) return null

  const brandList = input.brands
    .map((b, i) => `${i + 1}. ${b.name ?? b.domain} (${b.domain})`)
    .join('\n')

  const userMsg = [
    `URL: ${input.url}`,
    '',
    'Active Rooster brands (only flag matches against these):',
    brandList,
    '',
    'Page visible text (truncated):',
    text,
  ].join('\n')

  const allowed = new Set(input.brands.map(b => b.domain.toLowerCase()))

  return callOpenAI<RoosterBorderlineResult>(
    apiKey,
    ROOSTER_PROMPT,
    userMsg,
    raw => {
      if (typeof raw !== 'object' || raw === null) return null
      const obj = raw as {
        is_partner?: unknown
        matched_brand_domains?: unknown
        reasoning?: unknown
      }
      if (typeof obj.is_partner !== 'boolean') return null
      const matched =
        Array.isArray(obj.matched_brand_domains)
          ? (obj.matched_brand_domains as unknown[])
              .filter((d): d is string => typeof d === 'string')
              .map(d => d.toLowerCase())
              .filter(d => allowed.has(d))
          : []
      return {
        isPartner: obj.is_partner && matched.length > 0,
        matchedBrandDomains: matched,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
      }
    },
  )
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions wrapper with JSON-mode + timeout
// ---------------------------------------------------------------------------

async function callOpenAI<T>(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  parse: (raw: unknown) => T | null,
): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(
        '[llm-borderline] OpenAI HTTP %s: %s',
        res.status,
        (await res.text()).slice(0, 200),
      )
      return null
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = body.choices?.[0]?.message?.content
    if (!content) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }
    return parse(parsed)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn('[llm-borderline] OpenAI call timed out')
    } else {
      console.warn('[llm-borderline] OpenAI call failed:', err)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
