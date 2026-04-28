/**
 * Hunter.io domain-search fallback.
 *
 * Final tier in the contact-extraction cascade — only fires when both
 * the regex extractor and the GPT-4o + web_search call returned zero
 * emails. Hunter returns up to N emails associated with the domain
 * (generic "info@", "contact@" + any personal addresses they've seen).
 *
 * Returns null when HUNTER_API_KEY is unset or the call fails.
 */

export type HunterResult = {
  emails: string[]
  raw: { domain: string; total: number; organization: string | null }
}

const HUNTER_URL = 'https://api.hunter.io/v2/domain-search'
const TIMEOUT_MS = 15_000
const RESULT_LIMIT = 25

export async function findContactsWithHunter(domain: string): Promise<HunterResult | null> {
  const apiKey = process.env.HUNTER_API_KEY
  if (!apiKey) {
    console.warn('[contact-hunter] HUNTER_API_KEY not set — skipping Hunter fallback')
    return null
  }
  if (!domain) return null

  const params = new URLSearchParams({
    domain,
    api_key: apiKey,
    limit: String(RESULT_LIMIT),
  })
  const url = `${HUNTER_URL}?${params.toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[contact-hunter] ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const json = (await res.json()) as {
      data?: {
        domain?: string
        organization?: string | null
        emails?: Array<{ value?: string; type?: string; confidence?: number }>
      }
    }

    const raw = json.data?.emails ?? []
    const emails = raw
      .filter(e => typeof e?.value === 'string' && e.value.includes('@'))
      .map(e => (e.value as string).toLowerCase())

    return {
      emails: Array.from(new Set(emails)),
      raw: {
        domain: json.data?.domain ?? domain,
        total: emails.length,
        organization: json.data?.organization ?? null,
      },
    }
  } catch (err) {
    console.warn('[contact-hunter] call failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
