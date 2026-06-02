/**
 * Kick streamer contact extraction (Phase 3).
 *
 * kick-scorer.ts answers "is this a casino affiliate?". This answers the
 * next question — "how do we reach them?" — by mining the outreach contacts
 * a streamer leaves on their channel, in the priority order from the
 * outreach playbook: email > Telegram > Discord > social handles.
 *
 * Pure + synchronous (regex over already-fetched strings), so it runs in the
 * same inline server action as scoring with no extra I/O.
 *
 * Sources are scanned in order, earliest mention wins:
 *   1. channel_description (the About paragraph from api.kick.com)
 *   2. stream_title
 *   3. URLs already captured in kick_links (promo_card / pinned_chat, plus
 *      their resolved_url) — a "Telegram"/"Discord" channel-link card or a
 *      t.me/discord link pinned in chat is a contact even though Phase 2
 *      filed it as a promo link.
 */

export type KickSocialKey = 'instagram' | 'twitter' | 'facebook' | 'youtube' | 'tiktok'

export type KickContacts = {
  email: string | null
  telegram_url: string | null
  discord_url: string | null
  /** Full URLs, keyed by platform. Only platforms found are present.
   *  Stored full (not just the handle) to match the Phase 2 *_handle
   *  convention — youtube /@handle, instagram /name/, etc. all differ. */
  socials: Partial<Record<KickSocialKey, string>>
}

// http(s) URL run — stops at whitespace and common trailing delimiters.
const URL_RE = /https?:\/\/[^\s)>\]"'}]+/gi

// Email — local@domain.tld. Applied to text with URLs stripped out first so
// we don't pull "a@b.com" out of a path like site.com/u/a@b.com.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi
// Reject image/asset filenames that look like emails (sprite@2x.png, etc.).
const EMAIL_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mp4|webm|woff2?)$/i

// Telegram / Discord as they appear in free text (scheme optional). Non-global
// so .match() returns the first hit without lastIndex state to reset.
const TELEGRAM_TEXT_RE = /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.(?:me|dog))\/[a-z0-9_+/-]+/i
const DISCORD_TEXT_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i

function ensureScheme(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

/** Trim trailing punctuation a URL run commonly swallows from prose. */
function cleanUrl(u: string): string {
  return u.replace(/[).,;!?'"]+$/, '')
}

function hostOf(u: string): string {
  try {
    return new URL(ensureScheme(u)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// host (www-stripped) → social platform.
const SOCIAL_HOST_MAP: Array<[(h: string) => boolean, KickSocialKey]> = [
  [h => h === 'instagram.com', 'instagram'],
  [h => h === 'twitter.com' || h === 'x.com', 'twitter'],
  [h => h === 'facebook.com' || h === 'fb.com' || h === 'fb.me', 'facebook'],
  [h => h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com', 'youtube'],
  [h => h === 'tiktok.com' || h === 'vm.tiktok.com', 'tiktok'],
]

function socialKeyForHost(host: string): KickSocialKey | null {
  for (const [test, key] of SOCIAL_HOST_MAP) if (test(host)) return key
  return null
}

function isTelegramHost(host: string): boolean {
  return host === 't.me' || host === 'telegram.me' || host === 'telegram.dog'
}

/** discord.gg/* and discord(app).com/invite/* are invites (contactable).
 *  Bare discord.com (login, app, etc.) is not — require the /invite/ path. */
function isDiscordInvite(host: string, url: string): boolean {
  if (host === 'discord.gg') return true
  if (host === 'discord.com' || host === 'discordapp.com') return /\/invite\//i.test(url)
  return false
}

/** Fold a single URL into whichever contact slot it fills (first wins). */
function classifyUrl(rawUrl: string, out: KickContacts): void {
  const url = cleanUrl(rawUrl.trim())
  if (!url) return

  if (!out.email && /^mailto:/i.test(url)) {
    const e = (url.slice('mailto:'.length).split('?')[0] ?? '').trim().toLowerCase()
    if (e.includes('@') && !EMAIL_ASSET_RE.test(e)) out.email = e
    return
  }

  const host = hostOf(url)
  if (!host) return

  if (!out.telegram_url && isTelegramHost(host)) {
    out.telegram_url = ensureScheme(url)
    return
  }
  if (!out.discord_url && isDiscordInvite(host, url)) {
    out.discord_url = ensureScheme(url)
    return
  }
  const social = socialKeyForHost(host)
  // First card for a platform wins (don't clobber an earlier, richer link).
  if (social && !out.socials[social]) out.socials[social] = ensureScheme(url)
}

/**
 * Extract outreach contacts from a streamer's text surfaces and already-
 * captured link URLs. `texts` are scanned before `linkUrls`, so a contact
 * stated in the bio takes precedence over one inferred from a promo card.
 */
export function extractContacts(texts: string[], linkUrls: string[]): KickContacts {
  const out: KickContacts = { email: null, telegram_url: null, discord_url: null, socials: {} }
  const blob = texts.filter(Boolean).join('\n')

  if (blob) {
    // Email: strip URLs first so paths containing '@' don't false-positive.
    const emailScan = blob.replace(URL_RE, ' ')
    for (const m of emailScan.matchAll(EMAIL_RE)) {
      const e = m[0].toLowerCase()
      if (EMAIL_ASSET_RE.test(e)) continue
      out.email = e
      break
    }

    const tg = blob.match(TELEGRAM_TEXT_RE)
    if (tg) out.telegram_url = ensureScheme(cleanUrl(tg[0]))
    const dc = blob.match(DISCORD_TEXT_RE)
    if (dc) out.discord_url = ensureScheme(cleanUrl(dc[0]))

    // Socials from any full URLs in the text.
    for (const m of blob.matchAll(URL_RE)) classifyUrl(m[0], out)
  }

  // Fold in URLs Phase 2 already captured (cards + pinned + resolved).
  for (const u of linkUrls) {
    if (u) classifyUrl(u, out)
  }

  return out
}
