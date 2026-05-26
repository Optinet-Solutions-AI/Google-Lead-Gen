/**
 * Google Cloud Translation v2 — keyword → English.
 *
 * The QA team scrapes in local languages (Arabic, German, Norwegian…)
 * and needs to know what the keyword actually means before they can
 * triage a job. We translate the keyword once at enqueue time and
 * store the result on `scrape_queue.keyword_en`.
 *
 * The translation is best-effort: if GOOGLE_TRANSLATE_API_KEY isn't
 * set, the network call times out, or Google returns an error, we
 * return null and the caller leaves the column NULL. The UI handles
 * NULL by showing the original keyword only — translation must
 * never block an enqueue.
 */

const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2'
const TIMEOUT_MS = 5_000

type TranslateResponse = {
  data?: {
    translations?: Array<{
      translatedText?: string
      detectedSourceLanguage?: string
    }>
  }
  error?: { message?: string }
}

/**
 * Translate one or more keywords from `sourceLang` into English.
 * Returns a Map keyed by the ORIGINAL keyword so callers can match
 * results back to the input regardless of array order. Returns an
 * empty Map on missing key / network failure / non-2xx — never throws.
 */
export async function translateKeywordsToEnglish(
  keywords: string[],
  sourceLang: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY
  if (!apiKey) {
    console.warn('[translate] GOOGLE_TRANSLATE_API_KEY not set — skipping translation')
    return result
  }
  if (sourceLang === 'en') return result

  const unique = Array.from(new Set(keywords.map(k => k.trim()).filter(Boolean)))
  if (unique.length === 0) return result

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    // Google Translate v2 accepts repeated `q=` params. URLSearchParams
    // serialises an array as `q=a&q=b&q=c`, which matches their docs.
    const params = new URLSearchParams()
    for (const k of unique) params.append('q', k)
    params.set('source', sourceLang)
    params.set('target', 'en')
    params.set('format', 'text')
    params.set('key', apiKey)

    const res = await fetch(TRANSLATE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[translate] ${res.status}: ${body.slice(0, 200)}`)
      return result
    }
    const json = (await res.json()) as TranslateResponse
    const translations = json.data?.translations ?? []
    // Google preserves input order in `translations[]`, so we can zip
    // against `unique` 1:1. Skip empty / identical results — no point
    // storing a translation that's the same as the original.
    for (let i = 0; i < unique.length && i < translations.length; i++) {
      const original = unique[i]!
      const translated = translations[i]?.translatedText?.trim()
      if (translated && translated !== original) {
        result.set(original, translated)
      }
    }
    return result
  } catch (err) {
    console.warn('[translate] call failed:', err instanceof Error ? err.message : err)
    return result
  } finally {
    clearTimeout(timer)
  }
}
