import Link from 'next/link'
import { Plus } from 'lucide-react'

/**
 * "Scrape" call to action, in the two places it belongs.
 *
 * Desktop has room in the header, and top-right is where the eye goes for a
 * primary action, so it sits there. Phones and tablets get a floating button
 * instead, because the header scrolls away and the action needs to stay
 * reachable — it sits one step above the QA feedback launcher (fixed at
 * bottom-20) on a lower z-index, so the feedback panel opens over it rather
 * than the two fighting.
 */

/** Header action, desktop only. */
export function CreateScrapeHeaderButton() {
  return (
    <Link
      href="/scrape/new"
      className="hidden shrink-0 items-center gap-2 rounded-lg bg-[color:var(--color-text-primary)] px-5 py-2.5 text-[15px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 lg:inline-flex"
    >
      <Plus className="h-5 w-5" />
      Scrape
    </Link>
  )
}

/** Floating action, phones and tablets only. */
export function CreateScrapeFab() {
  return (
    <Link
      href="/scrape/new"
      aria-label="New scrape"
      className={[
        'fixed bottom-36 right-4 z-40 inline-flex items-center gap-2 rounded-full lg:hidden',
        'bg-[color:var(--color-text-primary)] px-4 py-3 text-[13px] font-semibold text-white',
        'shadow-lg transition-opacity hover:opacity-90',
        // Icon-only on the narrowest screens so it never crowds the launcher.
        'max-[380px]:px-3',
      ].join(' ')}
    >
      <Plus className="h-[18px] w-[18px] shrink-0" />
      <span className="max-[380px]:sr-only">Scrape</span>
    </Link>
  )
}
