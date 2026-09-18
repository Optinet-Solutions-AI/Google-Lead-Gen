'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, Save } from 'lucide-react'
import { setWebsiteProfileConfigAction, type SettingState } from '../actions'

const initial: SettingState = null

export type WebsiteProfileConfig = {
  ttl: { affiliate: number; rooster: number; contact: number; stags: number }
  bands: { fresh: number; recent: number; aging: number }
  dedupeEnabled: boolean
  llmFlagEnabled: boolean
  hasOpenAiKey: boolean
}

const inputCls =
  'w-24 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[13px] text-[color:var(--color-text-primary)]'

export function WebsiteProfileSettings({ config }: { config: WebsiteProfileConfig }) {
  const [state, action, pending] = useActionState(setWebsiteProfileConfigAction, initial)

  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">Verdict expiry (days)</legend>
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          How long a check stays trusted. A website seen again after its verdict expired is re-checked instead of
          inheriting the old answer. Manual overrides never expire.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Num label="Affiliate" name="ttl_affiliate" value={config.ttl.affiliate} />
          <Num label="Rooster brands" name="ttl_rooster" value={config.ttl.rooster} />
          <Num label="Contacts" name="ttl_contact" value={config.ttl.contact} />
          <Num label="S-tags" name="ttl_stags" value={config.ttl.stags} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">Recency colours (days since last seen)</legend>
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          Green up to <strong>fresh</strong>, lime up to <strong>recent</strong>, amber up to <strong>aging</strong>, red after that.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Num label="Fresh" name="band_fresh" value={config.bands.fresh} />
          <Num label="Recent" name="band_recent" value={config.bands.recent} />
          <Num label="Aging" name="band_aging" value={config.bands.aging} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">Behaviour</legend>
        <label className="flex items-start gap-2 text-[12px] text-[color:var(--color-text-primary)]">
          <input type="checkbox" name="dedupe" defaultChecked={config.dedupeEnabled} className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]" />
          <span>
            <span className="font-medium">One lead row per website.</span>{' '}
            <span className="text-[color:var(--color-text-secondary)]">
              A website seen again is logged as an appearance (timestamp, keyword, country) instead of a new lead row. Turn off to
              go back to one row per search result.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px] text-[color:var(--color-text-primary)]">
          <input type="checkbox" name="llm_flag" defaultChecked={config.llmFlagEnabled} className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]" />
          <span>
            <span className="font-medium">Ask OpenAI to flag obvious non-affiliates.</span>{' '}
            <span className="text-[color:var(--color-text-secondary)]">
              A few new websites per minute (gpt-4o-mini, fractions of a cent each). Only confident answers are flagged; the
              own-DB lists (operator denylist, social hosts, known non-affiliates) always run first.
            </span>
            {!config.hasOpenAiKey && (
              <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                no OpenAI key — set it on Integrations
              </span>
            )}
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
        {state?.status === 'ok' && (
          <p className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
            <CheckCircle2 className="h-3 w-3" />
            {state.message}
          </p>
        )}
        {state?.status === 'error' && (
          <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{state.error}</p>
        )}
      </div>
    </form>
  )
}

function Num({ label, name, value }: { label: string; name: string; value: number }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
      {label}
      <input type="number" name={name} min="1" step="1" defaultValue={value} required className={inputCls} />
    </label>
  )
}
