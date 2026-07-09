import { CheckCircle2, XCircle } from 'lucide-react'

/**
 * Shared "On Monday" cell for every platform's results table
 * (FB / YouTube / Twitch / Kick / X / TikTok / Snapchat / Telegram).
 *
 * Three explicit states — no more ambiguity between "on Monday" and
 * "not scored yet":
 *   is_known_on_monday === true  → green ✓ "On Monday" (+ matched-links count)
 *   is_known_on_monday === false → grey ✕ "Not on Monday"
 *   is_known_on_monday === null  → dash (—) — scoring hasn't run
 *
 * When the caller has the row-level flag (FB advertisers, Twitch
 * streamers) it wins. For platforms with only link-level flags
 * (YouTube channels, Kick streamers, X / TikTok / Snapchat /
 * Telegram creators) the caller derives the row state from the
 * links via {@link deriveMondayStatusFromLinks} and passes that in.
 */
export function MondayStatusCell({
  isKnownOnMonday,
  links,
}: {
  isKnownOnMonday: boolean | null | undefined
  /** Per-link states, used to render the "N/M links matched" subtitle
   *  when known. Optional — some tables don't expose the per-link
   *  breakdown and just pass []. */
  links?: Array<{ is_known_on_monday: boolean | null }>
}) {
  if (isKnownOnMonday === null || isKnownOnMonday === undefined) {
    return (
      <span
        className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
        title="Not scored yet — click “Score & check” on the panel above to run the Monday match."
      >
        —
      </span>
    )
  }
  if (isKnownOnMonday === true) {
    const total = links?.length ?? 0
    const matched = (links ?? []).filter(l => l.is_known_on_monday === true).length
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className="inline-flex w-fit cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
          title="This row is already known on a Monday board — either the profile matched by name/ID, or one of its links resolved to an S-tag on Monday. See the affiliate-links column for which URLs matched."
        >
          <CheckCircle2 className="h-3 w-3" /> On Monday
        </span>
        {total > 0 && (
          <span
            className="text-[10px] text-[color:var(--color-text-secondary)]"
            title={`${matched} of ${total} affiliate links matched a Monday item.`}
          >
            {matched}/{total} links
          </span>
        )}
      </div>
    )
  }
  return (
    <span
      className="inline-flex cursor-help items-center gap-1 rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]"
      title="Not on Monday yet — the profile name, its affiliate IDs, and its links were all checked against the four Monday boards and none matched."
    >
      <XCircle className="h-3 w-3" /> Not on Monday
    </span>
  )
}

/**
 * Roll up per-link Monday states into a single row-level verdict
 * when the row itself doesn't carry an is_known_on_monday flag.
 * Any known-true link marks the row known; else any known-false
 * link marks it explicitly checked-and-no-match; else null.
 */
export function deriveMondayStatusFromLinks(
  links: ReadonlyArray<{ is_known_on_monday: boolean | null }>,
): boolean | null {
  let seenFalse = false
  for (const l of links) {
    if (l.is_known_on_monday === true) return true
    if (l.is_known_on_monday === false) seenFalse = true
  }
  return seenFalse ? false : null
}
