import Link from 'next/link'
import { Plus } from 'lucide-react'

/**
 * Floating "Create scrape" action.
 *
 * Sits directly above the QA feedback launcher, which is fixed at
 * `bottom-20 right-4` — this takes `bottom-36`, one comfortable tap higher,
 * and a lower z-index so the feedback panel opens over it rather than
 * fighting it. Floating rather than sitting in the header so the action stays
 * reachable after the list has been scrolled, which is most of the time on a
 * phone.
 */
export function CreateScrapeButton() {
  return (
    <Link
      href="/scrape/new"
      aria-label="Create scrape"
      className={[
        'fixed bottom-36 right-4 z-40 inline-flex items-center gap-2 rounded-full',
        'bg-[color:var(--color-text-primary)] px-4 py-3 text-[13px] font-semibold text-white',
        'shadow-lg transition-opacity hover:opacity-90',
        // Round icon-only button on the narrowest screens so it never crowds
        // the feedback launcher; the label appears once there is room.
        'max-[380px]:px-3',
      ].join(' ')}
    >
      <Plus className="h-[18px] w-[18px] shrink-0" />
      <span className="max-[380px]:sr-only">Create scrape</span>
    </Link>
  )
}
