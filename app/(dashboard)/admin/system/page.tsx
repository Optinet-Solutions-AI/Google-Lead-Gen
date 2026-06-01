import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CaptchaSolverToggle } from './_components/captcha-solver-toggle'
import { CaptchaAutoSolveToggle } from './_components/captcha-auto-solve-toggle'
import { MaintenanceToggle } from './_components/maintenance-toggle'
import { ProxyBandwidthSettings } from './_components/proxy-bandwidth-settings'
import { BYTES_PER_GB } from '@/lib/proxy-bandwidth'

export const dynamic = 'force-dynamic'

export default async function AdminSystemPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/system')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  // Fetch the current value. The RPC returns jsonb; we coerce to a strict
  // boolean defaulting to true (the schema seeded that, but be defensive
  // against missing/legacy rows).
  const [
    { data: solverRaw },
    { data: autoSolveRaw },
    { data: maintRaw },
    { data: bwLimitRaw },
    { data: bwThresholdRaw },
    { data: bwSnap },
  ] = await Promise.all([
    svc.rpc('get_system_setting', { p_key: 'captcha_solver_enabled' }),
    svc.rpc('get_system_setting', { p_key: 'captcha_auto_solve' }),
    svc.rpc('get_system_setting', { p_key: 'maintenance_mode' }),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_limit_bytes' }),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_low_threshold_bytes' }),
    svc
      .from('proxy_bandwidth_snapshots')
      .select('used_bytes, remaining_bytes, is_low, captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const captchaSolverEnabled = solverRaw === false ? false : true
  // Auto-solve defaults OFF (the migration seeds false) — be defensive
  // against a missing row by treating anything but explicit true as off.
  const captchaAutoSolveEnabled = autoSolveRaw === true
  const maintenanceEnabled = maintRaw === true

  // Bandwidth config is stored in bytes; the form works in GB.
  const toBytes = (raw: unknown, fallback: number) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const bwLimitGb = toBytes(bwLimitRaw, 5 * BYTES_PER_GB) / BYTES_PER_GB
  const bwThresholdGb = toBytes(bwThresholdRaw, BYTES_PER_GB) / BYTES_PER_GB
  const bwLatest = bwSnap
    ? {
        usedGb: (bwSnap as { used_bytes: number }).used_bytes / BYTES_PER_GB,
        remainingGb: (bwSnap as { remaining_bytes: number }).remaining_bytes / BYTES_PER_GB,
        isLow: (bwSnap as { is_low: boolean }).is_low,
        capturedAt: (bwSnap as { captured_at: string }).captured_at,
      }
    : null

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          System Settings
        </h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Runtime feature flags. Changes take effect within ~5 seconds —
          workers re-read each flag at the start of every scrape job.
        </p>
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Captcha solver
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            When ON, scrapes that hit a captcha / age gate / cookie banner
            park in <code>needs_human</code> status and wait for an admin
            to click through via noVNC on{' '}
            <code>/admin/interactive</code>. When OFF, the same walls fail
            the job (status <code>captcha</code>) immediately so the queue
            doesn&apos;t pile up while noVNC is being set up or while an
            EU-market batch is in a rough captcha period.
          </p>
        </header>

        <CaptchaSolverToggle enabled={captchaSolverEnabled} />
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Captcha auto-solve (2Captcha)
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            When ON, captcha walls (Google <code>/sorry/</code> reCAPTCHA and
            Bing Cloudflare Turnstile) are sent to the paid 2Captcha service
            automatically — no operator action needed. A successful solve
            resumes the scrape; a failed solve falls through to the manual
            Captcha solver above (if ON) or fails the job for auto-retry.
            Requires <code>TWOCAPTCHA_API_KEY</code> in each VM&apos;s{' '}
            <code>~/.env</code>. <strong>Each solve costs credits</strong>, so
            leave this OFF until the key is deployed on all workers.
          </p>
        </header>

        <CaptchaAutoSolveToggle enabled={captchaAutoSolveEnabled} />
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Maintenance mode
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            When ON, every non-admin user is signed out and any sign-in
            attempt by a non-admin is rejected — they see a maintenance
            notice instead. Admins keep full access so deploys and
            migrations can land safely. Toggle OFF when work is done to
            let everyone back in.
          </p>
        </header>

        <MaintenanceToggle enabled={maintenanceEnabled} />
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Proxy bandwidth
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            How much data the <strong>Enigma</strong> proxy plan has left —
            the metered residential proxy your scrapes actually run through.
            The remaining GB is read from Enigma every 30 minutes and shown
            on the dashboard. Set the <strong>plan size</strong> to match
            what you&apos;ve topped up to (so the % used and the bar are
            right), and the <strong>warn below</strong> threshold to get an
            in-app low-balance warning before it runs out. (Email alerts
            aren&apos;t wired up yet — the warning shows on the dashboard.)
          </p>
        </header>

        <ProxyBandwidthSettings
          limitGb={bwLimitGb}
          thresholdGb={bwThresholdGb}
          latest={bwLatest}
        />
      </section>
    </div>
  )
}
