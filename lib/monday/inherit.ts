/**
 * Monday → our-data normalizers (LGP-215..217).
 *
 * Turn a matched Monday item (the jsonb `get_monday_item_for_lead` returns —
 * a to_jsonb() of the board replica row) into the shapes our tables use,
 * labeled as Monday-sourced. Pure functions, no I/O, so they're trivially
 * testable and reusable by the inheritance RPCs / backfill.
 *
 * The Affiliates board carries per-brand tracking-id columns; a non-empty
 * value means the affiliate promotes a brand in that family (and therefore
 * is a Rooster partner). See board-registry.ts for the column mapping.
 */
import type { ContactItem } from '../contact-extraction/extract'

/** Shape of the jsonb from get_monday_item_for_lead(). Only the fields we
 *  read are typed; `_board` is injected by the RPC. */
export type MondayItem = {
  _board?: string
  monday_item_id?: string | null
  email?: string | null
  website?: string | null
  affiliate_name?: string | null
  source?: string | null
  // Affiliates-board brand tracking-id columns (comma/tab separated ids).
  l7_sj_rs_lv_ro?: string | null
  rb_fp_su?: string | null
  pm?: string | null
  nd?: string | null
  // Not-relevant / email-undelivered boards.
  affiliate_id?: string | null
  raw_column_values?: Record<string, unknown> | null
  [k: string]: unknown
}

/** Brand-tracking columns on the Affiliates board → the brand families a
 *  non-empty value implies. (l7=Lucky7Even, sj=SpinJo, rs=RocketSpin,
 *  lv=LuckyVibe, ro=Rollero; rb=Rooster.bet, fp=FortunePlay, su=SpinsUp;
 *  pm=PlayMojo; nd=NovaDreams.) */
export const BRAND_COLUMNS: ReadonlyArray<{ col: keyof MondayItem; brands: string[] }> = [
  { col: 'l7_sj_rs_lv_ro', brands: ['Lucky7Even', 'SpinJo', 'RocketSpin', 'LuckyVibe', 'Rollero'] },
  { col: 'rb_fp_su', brands: ['Rooster.bet', 'FortunePlay', 'SpinsUp'] },
  { col: 'pm', brands: ['PlayMojo'] },
  { col: 'nd', brands: ['NovaDreams'] },
]

const MONDAY_ITEM_URL = (id?: string | null) => (id ? `https://monday.com/boards/item/${id}` : 'monday.com')

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function looksLikeEmail(e: string): boolean {
  const parts = e.split('@')
  if (parts.length !== 2) return false
  const [local, dom] = parts as [string, string]
  return !!local && !!dom && dom.includes('.') && !/\s/.test(e)
}

/** Split a Monday tracking-id cell ("157307,\t170530, 170531") into ids. */
function splitIds(cell: unknown): string[] {
  return str(cell)
    .split(/[,\t\s;]+/)
    .map(x => x.trim())
    .filter(x => /^[A-Za-z0-9_-]{2,}$/.test(x))
}

// ---------------------------------------------------------------------------
// LGP-215 — contacts
// ---------------------------------------------------------------------------
/** Email (+ website as a contact link) inherited from Monday, labeled. */
export function normalizeMondayContacts(item: MondayItem): ContactItem[] {
  const out: ContactItem[] = []
  const src = MONDAY_ITEM_URL(item.monday_item_id)
  const email = str(item.email).toLowerCase()
  if (email && looksLikeEmail(email)) {
    out.push({ kind: 'email', value: email, method: 'monday', sourceUrl: src, confidence: 0.9, label: 'monday.com' })
  }
  const website = str(item.website)
  if (website && /^https?:\/\//i.test(website)) {
    out.push({ kind: 'contact_link', value: website, method: 'monday', sourceUrl: src, confidence: 0.6, label: 'monday.com site' })
  }
  return out
}

// ---------------------------------------------------------------------------
// LGP-216 — s-tags
// ---------------------------------------------------------------------------
export type MondayStag = {
  s_tag: string
  brand: string | null
  is_rooster_brand: boolean
  origin: 'monday'
  source_param: string | null
}

/** Every tracking id in the brand columns becomes an s-tag labeled monday.
 *  The affiliate_id column (not-relevant / email boards) is also emitted. */
export function normalizeMondayStags(item: MondayItem): MondayStag[] {
  const out: MondayStag[] = []
  const seen = new Set<string>()
  const push = (s_tag: string, brand: string | null, rooster: boolean) => {
    const key = `${s_tag}|${brand ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ s_tag, brand, is_rooster_brand: rooster, origin: 'monday', source_param: null })
  }
  for (const { col, brands } of BRAND_COLUMNS) {
    const ids = splitIds(item[col])
    if (ids.length === 0) continue
    // The column groups several brands; label with the family (or the sole
    // brand when the column maps to exactly one).
    const brandLabel = brands.length === 1 ? brands[0]! : brands.join(' / ')
    for (const id of ids) push(id, brandLabel, true)
  }
  for (const id of splitIds(item.affiliate_id)) push(id, null, false)
  return out
}

// ---------------------------------------------------------------------------
// LGP-217 — affiliate / rooster classification
// ---------------------------------------------------------------------------
export type MondayClassification = {
  is_affiliate: boolean | null
  is_rooster_partner: boolean
  brand: string | null
  matchedBrandColumns: string[]
}

/** Derive classification from the matched item + which board it's on.
 *  Affiliates-board membership ⇒ is_affiliate. Any populated brand column
 *  ⇒ Rooster partner. `leads`/other boards don't imply affiliate status. */
export function classifyFromMonday(item: MondayItem, board?: string): MondayClassification {
  const b = board ?? item._board
  const matched: string[] = []
  let brand: string | null = null
  for (const { col, brands } of BRAND_COLUMNS) {
    if (splitIds(item[col]).length > 0) {
      matched.push(String(col))
      if (!brand) brand = brands.length === 1 ? brands[0]! : brands[0]!
    }
  }
  const isRooster = matched.length > 0
  // Only the affiliates board is a hard "is_affiliate = true" signal. A
  // Rooster-brand tracking id anywhere also implies affiliate. Other boards
  // (leads / not_relevant / email_undelivered) don't classify affiliate here.
  const isAffiliate = b === 'affiliates' || isRooster ? true : null
  return {
    is_affiliate: isAffiliate,
    is_rooster_partner: isRooster,
    brand: brand ?? (str(item.affiliate_name) || null),
    matchedBrandColumns: matched,
  }
}
