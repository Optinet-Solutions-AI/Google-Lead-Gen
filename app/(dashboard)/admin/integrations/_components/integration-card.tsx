'use client'

import { useActionState, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react'
import { saveSecretAction, testIntegrationAction, toggleIntegrationAction, type ActionState } from '../actions'

/** Plain-data mirror of IntegrationDef, safe to pass from a Server Component. */
export type CardDef = {
  key: string
  name: string
  purpose: string
  breaks: string
  usedBy: string[]
  critical: boolean
  probeable: boolean
  docsUrl?: string | undefined
  secretKind: 'db' | 'env' | 'none'
  /** Environment variable names, for the env case. */
  envNames: string[]
  /** Setting key, for the db case. */
  settingKey?: string | undefined
}

export type CardStatus = {
  configured: boolean
  source: 'database' | 'environment' | 'not needed' | 'missing'
  masked: string | null
  envPresent: string[]
  envShadowsDb: boolean
  enabled: boolean
  lastProbe: { at: string; ok: boolean; detail: string } | null
  warnings: string[]
}

const initial: ActionState = null

export function IntegrationCard({ def, status }: { def: CardDef; status: CardStatus }) {
  const [saveState, saveAction, saving] = useActionState(saveSecretAction, initial)
  const [testState, testAction, testing] = useActionState(testIntegrationAction, initial)
  const [toggleState, toggleAction, toggling] = useActionState(toggleIntegrationAction, initial)
  const [showInput, setShowInput] = useState(false)
  const [reveal, setReveal] = useState(false)

  const unavailable = !status.configured
  const tone = !status.enabled
    ? { badge: 'bg-zinc-100 text-zinc-600', label: 'Not in use', Icon: Circle }
    : unavailable
      ? { badge: def.critical ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900', label: 'Not configured', Icon: def.critical ? XCircle : AlertTriangle }
      : { badge: 'bg-emerald-100 text-emerald-800', label: 'In use', Icon: CheckCircle2 }

  return (
    <section
      className={[
        'flex flex-col gap-3 rounded-lg border p-4',
        status.enabled
          ? 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]'
          : 'border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)]/50',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            {def.name}
            {def.critical && (
              <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Critical
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">{def.purpose}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone.badge}`}>
          <tone.Icon className="h-3.5 w-3.5" />
          {tone.label}
        </span>
      </header>

      {/* Where the credential lives */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-[color:var(--color-text-secondary)]">Credential</dt>
        <dd className="min-w-0 text-[color:var(--color-text-primary)]">
          {def.secretKind === 'none' ? (
            'None required'
          ) : status.source === 'missing' ? (
            <span className="text-amber-800">
              Missing —{' '}
              {def.secretKind === 'db' ? 'add it below' : `set ${def.envNames.join(' and ')} in Vercel and on the VM`}
            </span>
          ) : (
            <>
              <span className="font-mono">{status.masked ?? 'set'}</span>
              <span className="text-[color:var(--color-text-secondary)]">
                {' '}
                · from {status.source === 'database' ? 'this page' : `environment (${status.envPresent.join(', ') || def.envNames.join(', ')})`}
              </span>
            </>
          )}
        </dd>
        <dt className="text-[color:var(--color-text-secondary)]">Used by</dt>
        <dd className="min-w-0 text-[color:var(--color-text-primary)]">{def.usedBy.join(' · ')}</dd>
        <dt className="text-[color:var(--color-text-secondary)]">If unavailable</dt>
        <dd className="min-w-0 text-[color:var(--color-text-secondary)]">{def.breaks}</dd>
        {status.lastProbe && (
          <>
            <dt className="text-[color:var(--color-text-secondary)]">Last test</dt>
            <dd className={`min-w-0 ${status.lastProbe.ok ? 'text-emerald-700' : 'text-red-700'}`}>
              {status.lastProbe.detail}
              <span className="text-[color:var(--color-text-secondary)]"> · {new Date(status.lastProbe.at).toLocaleString()}</span>
            </dd>
          </>
        )}
      </dl>

      {status.warnings.map(w => (
        <p key={w} className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}

      {/* Result lines from the three actions */}
      {[saveState, testState, toggleState].map((s, i) =>
        s ? (
          <p
            key={i}
            className={`rounded-md px-2.5 py-1.5 text-[11px] ${
              s.status === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {s.status === 'ok' ? s.message : s.error}
          </p>
        ) : null,
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {def.probeable && (
          <form action={testAction}>
            <input type="hidden" name="key" value={def.key} />
            <button
              type="submit"
              disabled={testing}
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-40"
              title="Make one real call to this service and report what came back"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
              Test connection
            </button>
          </form>
        )}

        {def.secretKind === 'db' && (
          <button
            type="button"
            onClick={() => setShowInput(v => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {status.configured ? 'Replace key' : 'Add key'}
          </button>
        )}

        <form action={toggleAction} className="ml-auto">
          <input type="hidden" name="key" value={def.key} />
          <input type="hidden" name="value" value={status.enabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={toggling}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-40',
              status.enabled
                ? 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
            ].join(' ')}
            title={
              status.enabled
                ? 'Mark as not available — the team sees this integration as out of use'
                : 'Mark as in use again'
            }
          >
            {toggling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {status.enabled ? 'Mark not available' : 'Mark in use'}
          </button>
        </form>
      </div>

      {/* Secret entry */}
      {def.secretKind === 'db' && showInput && (
        <form action={saveAction} className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
          <input type="hidden" name="key" value={def.key} />
          <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]" htmlFor={`secret-${def.key}`}>
            New {def.name} key
            <span className="flex items-center gap-1.5">
              <input
                id={`secret-${def.key}`}
                name="value"
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the key"
                className="min-w-0 flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 font-mono text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => setReveal(v => !v)}
                aria-label={reveal ? 'Hide the key' : 'Show the key'}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1.5 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </span>
          </label>
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">
            Stored in the database as <span className="font-mono">{def.settingKey}</span>. It is never shown again after saving, only its last four characters.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-text-primary)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save key
            </button>
            {status.source === 'database' && (
              <button
                type="submit"
                name="clear"
                value="1"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-[12px] text-red-700 hover:bg-red-50 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove stored key
              </button>
            )}
            {def.docsUrl && (
              <a
                href={def.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-[color:var(--color-text-secondary)] underline hover:text-[color:var(--color-text-primary)]"
              >
                Where to find it
              </a>
            )}
          </div>
        </form>
      )}
    </section>
  )
}
