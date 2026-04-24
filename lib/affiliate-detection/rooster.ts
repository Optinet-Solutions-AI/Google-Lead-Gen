/**
 * Rooster-brand link detector. Given a fetched HTML page, returns the
 * list of brand domains the page links out to — i.e. "this affiliate
 * site is already promoting our brands".
 *
 * Distinct from the Monday-duplicate check (Epic 7.1) — that one tells
 * you the lead's OWN domain is a Rooster brand. This tells you the
 * lead is ALREADY a partner promoting us.
 */

const HREF_RE = /href=["']([^"']+)["']/gi

export type RoosterMatch = {
  domain: string
  brand_name: string | null
  monday_item_id: string | null
}

export function findRoosterBrandLinks(
  html: string,
  brandList: ReadonlyArray<{ domain: string; brand_name: string | null; monday_item_id: string | null }>,
): RoosterMatch[] {
  if (!html || html.length < 100) return []
  if (brandList.length === 0) return []

  const brandsByDomain = new Map<string, { brand_name: string | null; monday_item_id: string | null }>()
  for (const b of brandList) {
    if (b.domain) brandsByDomain.set(b.domain.toLowerCase(), { brand_name: b.brand_name, monday_item_id: b.monday_item_id })
  }

  const found = new Map<string, RoosterMatch>()
  for (const m of html.matchAll(HREF_RE)) {
    const link = m[1]
    if (!link || !link.startsWith('http')) continue
    let host = ''
    try {
      host = new URL(link).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      continue
    }

    // Match against any registered brand domain (exact or subdomain match)
    for (const [brandDomain, meta] of brandsByDomain.entries()) {
      if (host === brandDomain || host.endsWith('.' + brandDomain)) {
        if (!found.has(brandDomain)) {
          found.set(brandDomain, { domain: brandDomain, ...meta })
        }
        break
      }
    }
  }

  return Array.from(found.values())
}
