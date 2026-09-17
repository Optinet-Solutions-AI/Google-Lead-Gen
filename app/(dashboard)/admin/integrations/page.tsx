import { redirect } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, KeyRound, XCircle } from 'lucide-react'
import { requireAdmin } from '@/lib/auth/require-admin'
import { createServiceClient } from '@/lib/supabase/service'
import { INTEGRATIONS } from './_lib/registry'
import { loadGoogleLoginHealth, loadIntegrationStatuses, type GoogleLoginRow } from './_lib/status'
import { IntegrationCard, type CardDef } from './_components/integration-card'
import { GoLoginDriftPanel, type DriftRowView } from './_components/gologin-drift-panel'

export const dynamic = 'force-dynamic'

/** Wall clock, read outside the component body to keep render pure. */
function readNowMs(): number {
  return Date.now()
}

const LOGIN_STATE: Record<GoogleLoginRow['state'], { label: string; tone: string; hint: string }> = {
  ok: { label: 'Healthy', tone: 'bg-emerald-100 text-emerald-800', hint: 'Used recently and the last sign-in succeeded.' },
  never_used: { label: 'Never used', tone: 'bg-amber-100 text-amber-900', hint: 'A credential is stored but no scrape has signed in with it yet.' },
  stale: { label: 'Stale', tone: 'bg-amber-100 text-amber-900', hint: 'No successful sign-in for over two weeks. Google may have expired the session.' },
  failing: { label: 'Failing', tone: 'bg-red-100 text-red-800', hint: 'The last sign-in attempt reported a failure.' },
  missing_credential: { label: 'No account', tone: 'bg-red-100 text-red-800', hint: 'This country needs a signed-in Google session but no credential is stored.' },
  not_required: { label: 'Not needed', tone: 'bg-zinc-100 text-zinc-600', hint: 'This country scrapes fine signed out.' },
}

export default async function IntegrationsPage() {
  const admin = await requireAdmin()
  if (!admin.ok) redirect('/')

  const nowMs = readNowMs()
  const svc = createServiceClient()

  const [statuses, googleRows, profileRows] = await Promise.all([
    loadIntegrationStatuses(),
    loadGoogleLoginHealth(nowMs),
    svc
      .from('gologin_profiles')
      .select('country_code, country_name, is_active, gologin_profile_id, gologin_display_name')
      .order('country_name', { ascending: true })
      .then(r => (r.data ?? []) as Array<{
        country_code: string
        country_name: string
        is_active: boolean
        gologin_profile_id: string | null
        gologin_display_name: string | null
      }>),
  ])

  const driftRows: DriftRowView[] = profileRows.map(p => ({
    country_code: p.country_code,
    country_name: p.country_name,
    is_active: p.is_active,
    db_profile_id: p.gologin_profile_id,
    db_display_name: p.gologin_display_name,
    live_name: null,
    state: p.gologin_profile_id ? 'unknown' : 'no_id',
  }))

  const all = INTEGRATIONS.map(d => ({ def: d, status: statuses[d.key] }))
  const inUse = all.filter(x => x.status.enabled && x.status.configured).length
  const missing = all.filter(x => x.status.enabled && !x.status.configured)
  const criticalMissing = missing.filter(x => x.def.critical)
  const disabled = all.filter(x => !x.status.enabled).length
  const loginProblems = googleRows.filter(r => r.state !== 'ok' && r.state !== 'not_required')
  const profilesUnlinked = driftRows.filter(r => r.state === 'no_id')

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">Integrations</h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Every outside service this product depends on, what it is for, whether we currently have access, and where its
          credential lives. Keys stored here are written to the database the workers read, and are never shown again after saving.
        </p>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="In use" value={String(inUse)} tone="ok" hint="Configured and marked available." />
        <Stat
          label="No access"
          value={String(missing.length)}
          tone={criticalMissing.length > 0 ? 'bad' : missing.length > 0 ? 'warn' : 'ok'}
          hint={criticalMissing.length > 0 ? `${criticalMissing.length} of them are critical.` : 'Nothing critical is missing.'}
        />
        <Stat label="Marked not available" value={String(disabled)} tone="plain" hint="Switched off here on purpose." />
        <Stat
          label="Account problems"
          value={String(loginProblems.length + profilesUnlinked.length)}
          tone={loginProblems.length + profilesUnlinked.length > 0 ? 'warn' : 'ok'}
          hint="Google sign-in accounts and unlinked country profiles."
        />
      </div>

      {criticalMissing.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">{criticalMissing.map(x => x.def.name).join(', ')}</span>{' '}
            {criticalMissing.length === 1 ? 'is' : 'are'} critical and not configured. Scraping will not work correctly until fixed.
          </span>
        </p>
      )}

      {/* Integration cards */}
      <div className="grid gap-3 lg:grid-cols-2">
        {all.map(({ def, status }) => {
          const card: CardDef = {
            key: def.key,
            name: def.name,
            purpose: def.purpose,
            breaks: def.breaks,
            usedBy: [...def.usedBy],
            critical: def.critical,
            probeable: def.probeable,
            docsUrl: def.docsUrl,
            secretKind: def.secret.kind,
            envNames: def.secret.kind === 'env' ? [...def.secret.envNames] : def.secret.kind === 'db' ? [...(def.secret.envFallback ?? [])] : [],
            settingKey: def.secret.kind === 'db' ? def.secret.settingKey : undefined,
          }
          return (
            <IntegrationCard
              key={def.key}
              def={card}
              status={{
                configured: status.configured,
                source: status.source,
                masked: status.masked,
                envPresent: status.envPresent,
                envShadowsDb: status.envShadowsDb,
                enabled: status.enabled,
                lastProbe: status.lastProbe,
                warnings: status.warnings,
              }}
            />
          )
        })}
      </div>

      {/* GoLogin drift */}
      <GoLoginDriftPanel initialRows={driftRows} />

      {/* Google login accounts */}
      <section className="flex flex-col gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
              <KeyRound className="h-3.5 w-3.5" /> Google sign-in accounts
            </h3>
            <p className="mt-0.5 max-w-2xl text-[12px] text-[color:var(--color-text-secondary)]">
              Stored per country and used when a profile needs a signed-in Google session. Nothing watches these, so a
              password change or an expired session only shows up as failed scrapes. This table is that watch.
            </p>
          </div>
          <Link
            href="/admin/google-login"
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            Manage accounts
          </Link>
        </header>

        {loginProblems.length === 0 ? (
          <p className="flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5" /> Every country that needs a Google account has a healthy one.
          </p>
        ) : (
          <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {loginProblems.length} account{loginProblems.length === 1 ? '' : 's'} need attention:{' '}
              {loginProblems.map(r => `${r.country_code} (${LOGIN_STATE[r.state].label.toLowerCase()})`).join(', ')}.
            </span>
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12px]">
            <thead>
              <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                <th className="py-1.5 pr-3 font-semibold">Country</th>
                <th className="py-1.5 pr-3 font-semibold">Needs login</th>
                <th className="py-1.5 pr-3 font-semibold">Account</th>
                <th className="py-1.5 pr-3 font-semibold">Last sign-in</th>
                <th className="py-1.5 pr-3 font-semibold">Result</th>
                <th className="py-1.5 font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {googleRows.map(r => {
                const copy = LOGIN_STATE[r.state]
                return (
                  <tr key={r.country_code} className="border-b border-[color:var(--color-border)] last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium text-[color:var(--color-text-primary)]">{r.country_name}</span>
                      <span className="text-[color:var(--color-text-secondary)]"> ({r.country_code})</span>
                    </td>
                    <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">{r.requires_login ? 'Yes' : 'No'}</td>
                    <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">{r.email ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">
                      {r.last_used_at ? `${new Date(r.last_used_at).toLocaleDateString()}${r.ageDays !== null ? ` · ${r.ageDays}d ago` : ''}` : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">{r.last_used_status ?? '—'}</td>
                    <td className="py-1.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${copy.tone}`} title={copy.hint}>
                        {copy.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'bad' | 'plain'
}) {
  const valueTone =
    tone === 'ok'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'bad'
          ? 'text-red-700'
          : 'text-[color:var(--color-text-primary)]'
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="text-[11px] text-[color:var(--color-text-secondary)]">{label}</div>
      <div className={`text-[20px] font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">{hint}</div>}
    </div>
  )
}
