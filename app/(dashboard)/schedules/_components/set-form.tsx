'use client'

import { useActionState, useState, type ChangeEvent } from 'react'
import {
  createScheduledSet,
  updateScheduledSet,
  type ActionState,
} from '../actions'
import { CRON_PRESETS } from '../_lib/cron-presets'

const initial: ActionState = null

type Props =
  | { mode: 'create' }
  | {
      mode: 'edit'
      set: {
        id: string
        name: string
        description: string | null
        cron: string | null
        is_active: boolean
        default_pages: number
        run_enrichment: boolean
      }
    }

export function SetForm(props: Props) {
  const [state, formAction, pending] = useActionState(
    props.mode === 'create' ? createScheduledSet : updateScheduledSet,
    initial,
  )

  const initialCron = props.mode === 'edit' ? props.set.cron ?? '' : ''
  const isPreset = CRON_PRESETS.some(p => p.value === initialCron)
  const [preset, setPreset] = useState<string>(
    !initialCron ? '' : isPreset ? initialCron : 'custom',
  )
  const [customCron, setCustomCron] = useState<string>(
    !initialCron || isPreset ? '' : initialCron,
  )

  function onPresetChange(e: ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value
    setPreset(v)
    if (v !== 'custom') setCustomCron('')
  }

  const cronToSubmit = preset === 'custom' ? customCron : preset

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {props.mode === 'edit' && <input type="hidden" name="id" value={props.set.id} />}
      <input type="hidden" name="cron" value={cronToSubmit} />

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" required>
          <input
            name="name"
            type="text"
            required
            maxLength={200}
            defaultValue={props.mode === 'edit' ? props.set.name : ''}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
          />
        </Field>

        <Field label="Default pages">
          <input
            name="default_pages"
            type="number"
            min={1}
            max={10}
            defaultValue={props.mode === 'edit' ? props.set.default_pages : 1}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={props.mode === 'edit' ? props.set.description ?? '' : ''}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
        />
      </Field>

      <Field label="Schedule (UTC)">
        <select
          value={preset}
          onChange={onPresetChange}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
        >
          <option value="">Ad-hoc only (no schedule)</option>
          {CRON_PRESETS.map(p => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom cron…</option>
        </select>
        {preset === 'custom' && (
          <input
            type="text"
            placeholder="0 */4 * * *"
            value={customCron}
            onChange={e => setCustomCron(e.target.value)}
            className="mt-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 font-mono text-[12px]"
          />
        )}
      </Field>

      <label className="flex items-center gap-2 text-[12px] text-[color:var(--color-text-primary)]">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={props.mode === 'edit' ? props.set.is_active : true}
          className="h-4 w-4"
        />
        Active (the scheduler only picks up active sets)
      </label>

      <label className="flex items-start gap-2 text-[12px] text-[color:var(--color-text-primary)]">
        <input
          name="run_enrichment"
          type="checkbox"
          defaultChecked={props.mode === 'edit' ? props.set.run_enrichment : false}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          Run full enrichment after each scheduled scrape
          <span className="block text-[10px] text-[color:var(--color-text-secondary)]">
            Auto-runs Monday dup check, affiliate detection, Rooster check, contact extraction, S-tag extraction + verify on each batch the cron creates.
          </span>
        </span>
      </label>

      {state?.status === 'ok' && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-[12px] text-green-700">
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {state.error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {pending
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create schedule'
              : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
      <span>
        {label}
        {required && ' *'}
      </span>
      {children}
    </label>
  )
}
