/**
 * OpenAI GPT-4o + web_search fallback for contact extraction.
 *
 * Called only when the regex-based extractor returns no useful contacts
 * across the homepage AND the contact-page on the lead's site. GPT-4o
 * uses the web_search tool to browse the public web for the domain's
 * business contact info.
 *
 * Returns null when OPENAI_API_KEY is unset or the call fails — the
 * caller falls back to Hunter.io.
 */

export type LLMContactResult = {
  emails: string[]
  phones: string[]
  contactPageUrl: string | null
  reasoning: string | null
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const TIMEOUT_MS = 45_000

const SYSTEM_PROMPT = `You are a research assistant whose only job is to find the public BUSINESS contact information for a given website.

You have access to a web_search tool — use it to browse the website and any reputable public sources (LinkedIn, WHOIS, SEC filings, official directories) that confirm contact details.

OUTPUT RULES:
- Return strict JSON matching the schema. No prose outside the JSON object.
- "emails": only public business addresses you can verify exist on the site or in a reputable public directory. Prefer info@, contact@, support@, partners@, business@, hello@. Never include emails from tracking/analytics services (sentry.io, googletagmanager.com, doubleclick.net, etc.).
- "phones": phone numbers from the site or directories, in international E.164 format if you can determine the country. Skip generic placeholder numbers.
- "contact_page_url": the canonical "Contact us" page URL on the site, or null if you couldn't find one.
- If you have low confidence, return empty arrays / null. NEVER invent contact details.`

export async function findContactsWithOpenAI(
  domain: string,
  url: string,
): Promise<LLMContactResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('[contact-llm] OPENAI_API_KEY not set — skipping LLM fallback')
    return null
  }
  if (!domain && !url) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        instructions: SYSTEM_PROMPT,
        input: `Find business contact info for: ${domain || url}\nMain URL: ${url}`,
        tools: [{ type: 'web_search_preview' }],
        text: {
          format: {
            type: 'json_schema',
            name: 'business_contacts',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                emails: {
                  type: 'array',
                  items: { type: 'string' },
                },
                phones: {
                  type: 'array',
                  items: { type: 'string' },
                },
                contact_page_url: {
                  type: ['string', 'null'],
                },
                reasoning: {
                  type: 'string',
                  description: 'One short sentence: where the contact came from.',
                },
              },
              required: ['emails', 'phones', 'contact_page_url', 'reasoning'],
            },
          },
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[contact-llm] OpenAI ${res.status}: ${body.slice(0, 400)}`)
      return null
    }

    const data = (await res.json()) as {
      output_text?: string
      output?: Array<{ content?: Array<{ text?: string }> }>
    }
    const text = data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? ''
    if (!text) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      console.warn(`[contact-llm] non-JSON output: ${text.slice(0, 200)}`)
      return null
    }
    const obj = parsed as {
      emails?: unknown
      phones?: unknown
      contact_page_url?: unknown
      reasoning?: unknown
    }
    const emails = Array.isArray(obj.emails)
      ? (obj.emails.filter(e => typeof e === 'string') as string[])
      : []
    const phones = Array.isArray(obj.phones)
      ? (obj.phones.filter(p => typeof p === 'string') as string[])
      : []
    const contactPageUrl = typeof obj.contact_page_url === 'string' ? obj.contact_page_url : null
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : null

    return { emails, phones, contactPageUrl, reasoning }
  } catch (err) {
    console.warn('[contact-llm] call failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
