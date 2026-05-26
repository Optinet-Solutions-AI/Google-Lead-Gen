/**
 * MyMemory translation API — keyword → English.
 *
 * The QA team scrapes in local languages (Arabic, German, Norwegian…)
 * and needs to know what the keyword actually means before they can
 * triage a job. We translate the keyword once at enqueue time and
 * store the result on `scrape_queue.keyword_en`.
 *
 * Why MyMemory and not Google Cloud Translation?
 *   - No GCP project, no billing, no API key to manage.
 *   - 5k words/day anonymous, 50k/day with a `de=<email>` param
 *     (unverified — set MYMEMORY_EMAIL to lift the limit).
 *   - Trade-off: quality is "decent" not "great" — fine for
 *     "what's this keyword roughly about" but reads more literal
 *     than Google for non-Latin scripts. Acceptable for QA triage.
 *
 * The translation is best-effort: timeouts, non-2xx responses, and
 * over-quota errors all return null without throwing. Translation
 * must never block an enqueue.
 */

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get'
const TIMEOUT_MS = 5_000
// Per-keyword requests run in parallel up to this fan-out. MyMemory
// doesn't publish a rate limit; 5 is conservative enough to stay
// well clear of any abuse heuristics while keeping a 10-keyword
// batch under ~1.5 s end-to-end.
const CONCURRENCY = 5

type MyMemoryResponse = {
  responseData?: { translatedText?: string; match?: number }
  responseStatus?: number | string
  responseDetails?: string
}

/**
 * Translate one or more keywords from `sourceLang` into English.
 * Returns a Map keyed by the ORIGINAL keyword so callers can match
 * results back to the input regardless of completion order. Returns
 * an empty Map for English source / empty input / total API failure —
 * never throws. Individual keywords that fail are silently dropped.
 */
export async function translateKeywordsToEnglish(
  keywords: string[],
  sourceLang: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (sourceLang === 'en') return result

  const unique = Array.from(new Set(keywords.map(k => k.trim()).filter(Boolean)))
  if (unique.length === 0) return result

  const email = process.env.MYMEMORY_EMAIL?.trim() || undefined

  // Bounded-concurrency worker pool: shift keywords off a shared queue.
  const queue = [...unique]
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const keyword = queue.shift()
      if (!keyword) return
      const translated = await translateOne(keyword, sourceLang, email)
      if (translated && translated !== keyword) {
        result.set(keyword, translated)
      }
    }
  }
  const workers = Math.min(CONCURRENCY, unique.length)
  await Promise.all(Array.from({ length: workers }, worker))

  return result
}

async function translateOne(
  text: string,
  sourceLang: string,
  email: string | undefined,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const params = new URLSearchParams({
      q: text,
      langpair: `${sourceLang}|en`,
    })
    if (email) params.set('de', email)

    const res = await fetch(`${MYMEMORY_URL}?${params.toString()}`, {
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[translate] ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const json = (await res.json()) as MyMemoryResponse
    // MyMemory returns responseStatus as either a number (200) or a
    // string ("200") depending on the error type. Numeric coerce both.
    const status = Number(json.responseStatus)
    if (status !== 200) {
      console.warn(
        `[translate] responseStatus=${json.responseStatus}: ${(json.responseDetails ?? '').slice(0, 200)}`,
      )
      return null
    }
    const translated = json.responseData?.translatedText?.trim()
    return translated || null
  } catch (err) {
    console.warn('[translate] call failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
