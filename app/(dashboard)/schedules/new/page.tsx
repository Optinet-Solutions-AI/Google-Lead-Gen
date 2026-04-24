import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { SetForm } from '../_components/set-form'

export default function NewSchedulePage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-1.5">
        <Link
          href="/schedules"
          className="inline-flex w-fit items-center gap-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Schedules
        </Link>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          New schedule
        </h1>
        <p className="text-[12px] text-[color:var(--color-text-secondary)]">
          Create an empty set. Add keywords on the next screen.
        </p>
      </header>

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <SetForm mode="create" />
      </div>
    </div>
  )
}
