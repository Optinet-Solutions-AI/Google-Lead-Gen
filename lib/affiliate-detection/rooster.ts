/**
 * Rooster-brand detector for the cheap-pass HTML check. Combines three
 * signals:
 *
 *   1. href="…" pointing at a brand domain (or subdomain).
 *   2. <img alt="Spinjo"> matching a brand name or domain stem.
 *   3. <img src="…/logo-spinjo.svg"> — any asset URL whose path
 *      contains a brand stem as a whole token.
 *
 * Distinct from the Monday-duplicate check (Epic 7.1), which tells
 * you the lead's OWN domain is a Rooster brand. This tells you the
 * lead is ALREADY a partner promoting us.
 *
 * Stems shorter than 4 chars are skipped to avoid false positives on
 * generic words. Names are matched as whole tokens / whole alt values
 * to avoid the same.
 */

const HREF_RE = /href=["']([^"']+)["']/gi
const ALT_RE = /<img[^>]*\balt\s*=\s*["']([^"']+)["']/gi
const SRC_RE = /\b(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi
const MIN_STEM = 4

export type RoosterMatch = {
  domain: string
  brand_name: string | null
  monday_item_id: string | null
}

type BrandRow = {
  domain: string
  brand_name: string | null
  monday_item_id: string | null
}

export function findRoosterBrandLinks(
  html: string,
  brandList: ReadonlyArray<BrandRow>,
): RoosterMatch[] {
  if (!html || html.length < 100) return []
  if (brandList.length === 0) return []

  const brandsByDomain = new Map<string, { brand_name: string | null; monday_item_id: string | null }>()
  // Index keyed by both the brand_name (for alt-attr match) and the
  // domain stem (for image-filename token match). Lowercased.
  const brandsByToken = new Map<string, BrandRow>()
  for (const b of brandList) {
    if (!b.domain) continue
    // Strip a leading `www.` so brands stored as `www.spinjo.com` are
    // keyed the same as `spinjo.com` — the href host has already had
    // `www.` removed at line 70, and without this the equality check
    // silently misses.
    const dom = b.domain.toLowerCase().replace(/^www\./, '')
    brandsByDomain.set(dom, { brand_name: b.brand_name, monday_item_id: b.monday_item_id })
    if (b.brand_name) {
      const name = b.brand_name.trim().toLowerCase()
      if (name.length >= MIN_STEM) brandsByToken.set(name, b)
    }
    // Strip a leading `www.` so the stem reflects the brand, not the
    // subdomain — otherwise every `www.<anything>.com` brand collapses
    // to the single token "www".
    const stem = dom.replace(/^www\./, '').split('.')[0] ?? ''
    if (stem.length >= MIN_STEM) brandsByToken.set(stem, b)
  }

  const found = new Map<string, RoosterMatch>()

  // ----- Signal 1: href= pointing at a brand domain -----
  for (const m of html.matchAll(HREF_RE)) {
    const link = m[1]
    if (!link || !link.startsWith('http')) continue
    let host = ''
    try {
      host = new URL(link).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      continue
    }
    for (const [brandDomain, meta] of brandsByDomain.entries()) {
      if (host === brandDomain || host.endsWith('.' + brandDomain)) {
        if (!found.has(brandDomain)) {
          found.set(brandDomain, { domain: brandDomain, ...meta })
        }
        break
      }
    }
  }

  // ----- Signal 2: <img alt="Brand"> exact match -----
  for (const m of html.matchAll(ALT_RE)) {
    const alt = m[1]?.trim().toLowerCase()
    if (!alt || alt.length < MIN_STEM) continue
    const hit = brandsByToken.get(alt)
    if (hit && !found.has(hit.domain)) {
      found.set(hit.domain, {
        domain: hit.domain,
        brand_name: hit.brand_name,
        monday_item_id: hit.monday_item_id,
      })
    }
  }

  // ----- Signal 3: image asset URLs containing a brand stem as a token -----
  for (const m of html.matchAll(SRC_RE)) {
    const src = m[1]?.toLowerCase() ?? ''
    if (!src) continue
    // "logo-spinjo.svg" → tokens ["logo", "spinjo", "svg"]
    const tokens = src.split(/[^a-z0-9]+/).filter(t => t.length >= MIN_STEM)
    for (const tok of tokens) {
      const hit = brandsByToken.get(tok)
      if (hit && !found.has(hit.domain)) {
        found.set(hit.domain, {
          domain: hit.domain,
          brand_name: hit.brand_name,
          monday_item_id: hit.monday_item_id,
        })
      }
    }
  }

  return Array.from(found.values())
}
