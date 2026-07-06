import { SearchX } from 'lucide-react'

/**
 * Companion badge for the S-tags cell. Surfaces the "the s-tag scan
 * ran but found nothing" state, which is otherwise indistinguishable
 * from "never scanned" (both show No / —).
 *
 * Only renders when the lead was checked (s_tags_checked_at set) yet
 * has no tags. This is the condition that used to silently wipe a
 * lead's proven s-tags before the empty-run guard (migration
 * 20260706120000_stag_preserve_tags_on_empty); existing tags are now
 * preserved on such a run, and this badge makes the outcome visible.
 */
export function StagCheckHint({
  checkedAt,
  hasTags,
}: {
  checkedAt: string | null
  hasTags: boolean | null
}) {
  if (!checkedAt || hasTags) return null
  const when = new Date(checkedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  return (
    <span
      title={`S-tag scan ran ${when} and found none. Any existing s-tags are preserved.`}
      className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-800"
    >
      <SearchX className="h-2.5 w-2.5" />
      checked · none
    </span>
  )
}
