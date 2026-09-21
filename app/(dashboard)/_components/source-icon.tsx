'use client'

import {
  SiFacebook,
  SiGoogle,
  SiKick,
  SiSnapchat,
  SiTelegram,
  SiTiktok,
  SiTwitch,
  SiX,
  SiYoutube,
} from 'react-icons/si'

/**
 * Brand mark for a scrape source.
 *
 * Simple Icons (via react-icons) covers every engine we run except Bing —
 * Microsoft had it removed over trademark policy — so Bing keeps a letter
 * monogram, and so does anything we add later before an icon exists.
 */

type IconFn = (props: { className?: string }) => React.ReactElement

const BRAND: Record<string, { Icon?: IconFn; mono?: string; tint: string }> = {
  google: { Icon: SiGoogle as IconFn, tint: 'text-[#4285F4]' },
  bing: { mono: 'b', tint: 'text-[#0F7DBE]' },
  youtube: { Icon: SiYoutube as IconFn, tint: 'text-[#FF0000]' },
  twitch: { Icon: SiTwitch as IconFn, tint: 'text-[#9146FF]' },
  kick: { Icon: SiKick as IconFn, tint: 'text-[#53FC18]' },
  x: { Icon: SiX as IconFn, tint: 'text-[color:var(--color-text-primary)]' },
  facebook: { Icon: SiFacebook as IconFn, tint: 'text-[#1877F2]' },
  tiktok: { Icon: SiTiktok as IconFn, tint: 'text-[color:var(--color-text-primary)]' },
  snapchat: { Icon: SiSnapchat as IconFn, tint: 'text-[#FFFC00]' },
  telegram: { Icon: SiTelegram as IconFn, tint: 'text-[#26A5E4]' },
}

export function SourceIcon({
  engine,
  className = 'h-4 w-4',
  /** Brand colour, or inherit the surrounding text colour. */
  tinted = true,
}: {
  engine: string | null | undefined
  className?: string
  tinted?: boolean
}) {
  const key = (engine ?? '').toLowerCase()
  const brand = BRAND[key]

  if (!brand) {
    return (
      <span
        aria-hidden
        className={`inline-flex items-center justify-center rounded-[3px] bg-[color:var(--color-bg-secondary)] px-1 text-[10px] font-bold uppercase text-[color:var(--color-text-secondary)] ${className}`}
      >
        {(key[0] ?? '?').toUpperCase()}
      </span>
    )
  }

  if (brand.Icon) {
    const Icon = brand.Icon
    return <Icon className={`${className} shrink-0 ${tinted ? brand.tint : ''}`} />
  }

  // Monogram fallback (Bing).
  return (
    <span
      aria-hidden
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-[3px] font-bold leading-none',
        'bg-[color:var(--color-bg-secondary)] text-[11px]',
        tinted ? brand.tint : 'text-[color:var(--color-text-secondary)]',
        className,
      ].join(' ')}
    >
      {brand.mono}
    </span>
  )
}
