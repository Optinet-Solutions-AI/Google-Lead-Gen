'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { toggleJobReviewed } from '../actions'
import type { ScrapeJob } from '../_lib/pipeline'

/** A "have we checked this scrape yet?" box for the Recent-jobs table.
 *  Team-wide (the flag lives on the job row, not per-user), optimistic, and
 *  swallows the row's wrapping <Link> click so ticking it never navigates. */
export function ReviewedCheckbox({ job }: { job: ScrapeJob }) {
  const [checked, setChecked] = useState(job.reviewed_at != null)
  const [pending, start] = useTransition()

  const tooltip = checked
    ? `Reviewed${job.reviewed_by ? ` by ${job.reviewed_by}` : ''}${
        job.reviewed_at ? ` on ${new Date(job.reviewed_at).toLocaleString()}` : ''
      } — click to unmark`
    : 'Not reviewed yet — click once you have checked this scrape'

  function onToggle(e: React.MouseEvent | React.ChangeEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (pending) return
    const next = !checked
    setChecked(next) // optimistic
    const fd = new FormData()
    fd.set('job_id', job.id)
    fd.set('reviewed', String(next))
    start(async () => {
      const res = await toggleJobReviewed(null, fd)
      if (res?.status === 'error') setChecked(!next) // revert on failure
    })
  }

  return (
    <label
      className="inline-flex cursor-pointer items-center justify-center"
      title={tooltip}
      onClick={e => e.stopPropagation()}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--color-text-secondary)]" />
      ) : (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={checked ? 'Mark scrape as not reviewed' : 'Mark scrape as reviewed'}
          className="h-4 w-4 cursor-pointer rounded accent-[color:var(--color-accent)]"
        />
      )}
    </label>
  )
}
