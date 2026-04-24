'use client'

import { useActionState } from 'react'
import {
  CheckCircle2,
  Database,
  Mail,
  Search,
  Tag,
  Users,
} from 'lucide-react'
import {
  checkMondayDuplicates,
  runAffiliateDetection,
  runContactExtraction,
  runRoosterCheck,
  runStagDuplicateCheck,
  runStagExtraction,
  type CheckMondayState,
  type StageRunState,
} from '../actions'

const initialMonday: CheckMondayState = null
const initialStage: StageRunState = null

type StageProps = {
  jobId: string
  label: string
  icon: React.ReactNode
}

function StageRow({
  jobId,
  label,
  icon,
  pending,
  message,
  error,
  action,
}: StageProps & {
  pending: boolean
  message: string | null
  error: string | null
  action: (formData: FormData) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <form action={action}>
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-w-[200px] items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50"
        >
          {icon}
          {label}
        </button>
      </form>
      <div className="text-[11px]">
        {pending && <span className="text-[color:var(--color-text-secondary)]">Running…</span>}
        {!pending && message && (
          <span className="rounded-md bg-green-50 px-2 py-1 text-green-700">{message}</span>
        )}
        {!pending && error && (
          <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">{error}</span>
        )}
      </div>
    </div>
  )
}

function MondayStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(checkMondayDuplicates, initialMonday)
  return (
    <StageRow
      jobId={jobId}
      label="1. Check Monday duplicates"
      icon={<Database className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

function AffiliateStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(runAffiliateDetection, initialStage)
  return (
    <StageRow
      jobId={jobId}
      label="2. Detect affiliates"
      icon={<Search className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

function RoosterStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(runRoosterCheck, initialStage)
  return (
    <StageRow
      jobId={jobId}
      label="3. Check Rooster brands"
      icon={<CheckCircle2 className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

function ContactStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(runContactExtraction, initialStage)
  return (
    <StageRow
      jobId={jobId}
      label="4. Extract contacts"
      icon={<Mail className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

function StagExtractStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(runStagExtraction, initialStage)
  return (
    <StageRow
      jobId={jobId}
      label="5. Extract s-tags (affiliates)"
      icon={<Tag className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

function StagCheckStage({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(runStagDuplicateCheck, initialStage)
  return (
    <StageRow
      jobId={jobId}
      label="6. Check s-tags on Monday"
      icon={<Users className="h-3 w-3" />}
      pending={pending}
      action={action}
      message={state?.status === 'ok' ? state.message : null}
      error={state?.status === 'error' ? state.error : null}
    />
  )
}

export function EnrichmentStages({ jobId }: { jobId: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Enrichment pipeline
      </h2>
      <MondayStage jobId={jobId} />
      <AffiliateStage jobId={jobId} />
      <RoosterStage jobId={jobId} />
      <ContactStage jobId={jobId} />
      <StagExtractStage jobId={jobId} />
      <StagCheckStage jobId={jobId} />
    </section>
  )
}
