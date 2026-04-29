'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  Cog,
  Database,
  FileCode,
  GitBranch,
  HelpCircle,
  Layers,
  Network,
  Server,
  Settings,
  Workflow,
} from 'lucide-react'

type SectionDef = {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
}

const SECTIONS: SectionDef[] = [
  { id: 'overview', title: 'Architecture overview', icon: Boxes },
  { id: 'scrape-flow', title: 'Scrape pipeline', icon: Workflow },
  { id: 'enrichment-flow', title: 'Enrichment chain', icon: Layers },
  { id: 'schema', title: 'Database schema', icon: Database },
  { id: 'api', title: 'API endpoints', icon: Network },
  { id: 'rpcs', title: 'Supabase RPCs', icon: FileCode },
  { id: 'cron', title: 'Cron jobs', icon: Cog },
  { id: 'env', title: 'Environment variables', icon: Settings },
  { id: 'vm', title: 'VM deployment', icon: Server },
  { id: 'migrations', title: 'Database migrations', icon: GitBranch },
  { id: 'troubleshoot', title: 'Troubleshooting', icon: AlertTriangle },
]

function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? '')
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]?.target.id) setActive(visible[0].target.id)
      },
      { rootMargin: '-25% 0px -60% 0px', threshold: 0 },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [ids])
  return active
}

export default function HelpPage() {
  const ids = useMemo(() => SECTIONS.map(s => s.id), [])
  const active = useScrollSpy(ids)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-5 w-5 text-[color:var(--color-accent)]" />
          <h1 className="text-[18px] font-semibold text-[color:var(--color-text-primary)]">
            Help & technical reference
          </h1>
        </div>
        <p className="max-w-3xl text-[13px] text-[color:var(--color-text-secondary)]">
          The full reference. Architecture, every workflow, every API endpoint,
          every RPC, env vars, deploy steps, and troubleshooting. For a
          friendlier feature tour see{' '}
          <a className="underline underline-offset-2" href="/onboarding">
            /onboarding
          </a>
          .
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-[230px_1fr]">
        <aside className="md:sticky md:top-4 md:self-start">
          <nav className="flex flex-col gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2">
            {SECTIONS.map((s, i) => {
              const Icon = s.icon
              const isActive = active === s.id
              return (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={[
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                    isActive
                      ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                      : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                  ].join(' ')}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">
                    {i + 1}. {s.title}
                  </span>
                </a>
              )
            })}
          </nav>
        </aside>

        <div className="flex flex-col gap-6">
          <Section id="overview" title="Architecture overview" icon={Boxes}>
            <p>
              Three-tier system: a Next.js app on Vercel, a Supabase Postgres
              database (plus Storage + RLS), and a fleet of Python workers
              running on AWS VMs that drive GoLogin Chromium browsers.
            </p>
            <Pre>{`┌─ User ────────────────────────────────────────┐
│  Next.js app on Vercel                          │
│  /scrape, /leads, /scrape/[id], /onboarding…   │
└─────────┬───────────────────────────────────────┘
          │ server actions / RPCs
          ▼
┌─ Supabase Postgres ─────────────────────────────┐
│  scrape_queue · google_lead_gen_table           │
│  enrichment_fetch_queue · s_tags_table          │
│  fetched_html_cache · activity_log              │
│  Monday replica (4 boards)                       │
└──┬─────────────────────┬─────────────────────────┘
   │ poll                │ poll
   ▼                     ▼
┌─ scrape-worker@9222/3/4 ┐  ┌─ enrichment-worker@9225/6/7 ┐
│ Python + GoLogin        │  │ Python + GoLogin             │
│ run scraper.py per job  │  │ fetch HTML, screenshot,      │
│                         │  │ POST /api/enrichment/score-row│
└─────────────────────────┘  └──────────────────────────────┘`}</Pre>
            <ul>
              <li>
                <strong>Frontend / API</strong> — Next.js 16 App Router on
                Vercel. Server actions handle mutations; API routes handle
                webhooks, internal worker callbacks, and Vercel cron.
              </li>
              <li>
                <strong>Database</strong> — Supabase Postgres with RLS enabled
                on every table (no policies → service-role-only). Storage for
                screenshots in the private <Code>lead-screenshots</Code>{' '}
                bucket.
              </li>
              <li>
                <strong>Workers</strong> — six systemd units on the AWS VM,
                three for scraping (ports 9222/3/4) and three for enrichment
                fetches (9225/6/7). Each runs its own GoLogin Chromium for
                country-specific browsing.
              </li>
              <li>
                <strong>Country lock</strong> —{' '}
                <Code>active_profile_locks</Code> guarantees only one worker
                holds a country profile at a time, preventing parallel sessions
                that would trip Google&apos;s bot detection.
              </li>
            </ul>
          </Section>

          <Section id="scrape-flow" title="Scrape pipeline workflow" icon={Workflow}>
            <p>
              Step-by-step trace of what happens between submitting the form
              and rows landing in <Code>google_lead_gen_table</Code>.
            </p>
            <Steps
              items={[
                <>
                  User submits the <Code>/scrape</Code> form (keyword × country
                  × language × pages × priority × with_enrichment).
                </>,
                <>
                  <Code>enqueueScrape</Code> server action validates fields,
                  splits the textarea into one row per keyword, and bulk-inserts
                  into <Code>scrape_queue</Code> with{' '}
                  <Code>status=&apos;pending&apos;</Code>.
                </>,
                <>
                  An <Code>activity_log</Code> row records the enqueue (user,
                  count, country, language).
                </>,
                <>
                  Every 5 seconds each scrape worker calls{' '}
                  <Code>claim_scrape_job(worker_id)</Code>. The RPC picks the
                  oldest pending row whose country isn&apos;t locked, locks the
                  country, marks the row <Code>running</Code>, and returns it.
                </>,
                <>
                  Worker runs{' '}
                  <Code>
                    python3 ~/scraper.py &lt;profile_id&gt; -k &quot;…&quot; -c
                    &quot;…&quot; --pages N --port 9222 --language &lt;hl&gt;
                  </Code>
                  . The script opens GoLogin Chromium and navigates to{' '}
                  <Code>
                    https://www.google.com/search?q=&hl=&start=
                  </Code>
                  .
                </>,
                <>
                  scraper.py parses results, writes JSON to disk, exits. Worker
                  reads the JSON.
                </>,
                <>
                  Worker calls{' '}
                  <Code>complete_scrape_job(uuid, results, summary)</Code> —
                  atomic: increments <Code>batch_counter</Code>, inserts every
                  result into <Code>google_lead_gen_table</Code>, marks the
                  queue row <Code>completed</Code>, releases the country lock.
                  Honors <Code>result_type_filter</Code> if set (PPC-only or
                  Organic-only re-runs).
                </>,
                <>
                  If <Code>with_enrichment=true</Code>, the next scheduler-tick
                  cron call (within 60s) invokes{' '}
                  <Code>advance_enrichment_chain(uuid)</Code> which kicks off
                  the 6-stage enrichment pipeline.
                </>,
              ]}
            />
            <Tip>
              On scrape failure, <Code>fail_scrape_job</Code> bumps the row back
              to <Code>pending</Code> and increments attempts. After{' '}
              <Code>max_attempts</Code> (default 3) it goes to{' '}
              <Code>failed</Code>. CAPTCHA hits go straight to{' '}
              <Code>captcha</Code> via <Code>captcha_scrape_job</Code> — no
              retry.
            </Tip>
          </Section>

          <Section
            id="enrichment-flow"
            title="Enrichment chain workflow"
            icon={Layers}
          >
            <p>
              The orchestrator <Code>advance_enrichment_chain(uuid)</Code> is
              called every minute by the scheduler tick cron for every job
              with <Code>with_enrichment=true</Code> that isn&apos;t yet{' '}
              <Code>complete</Code>. It&apos;s idempotent — calling it
              repeatedly during a phase is a no-op.
            </p>
            <Pre>{`pending → affiliate_running → all_running → complete

Phase 0+1  (pending → affiliate_running)
  • Run mark_monday_duplicates_for_job (pure DB).
  • Insert enrichment_fetch_queue rows with
    process_stages=['affiliate'] for every non-overridden lead.

Phase 2  (affiliate_running → all_running)
  • Wait until every lead is either:
      - is_affiliate_overridden_at NOT NULL, or
      - affiliate_checked_at NOT NULL, or
      - has no pending/running/paused queue row for 'affiliate'
  • Then enqueue rooster + contact (all leads) and stag (affiliate=true only).

Phase 3  (all_running → complete)
  • Same blocked-check on rooster, contact, and stag.
  • When all are terminal, set enrichment_status='complete'.`}</Pre>
            <p>
              Worker side: each enrichment worker polls{' '}
              <Code>claim_enrichment_fetch_job</Code>, opens GoLogin (multi-page
              navigation for contact + s-tag), then POSTs to{' '}
              <Code>/api/enrichment/score-row</Code> with the stage name + HTML
              (and any extras like resolved s-tags or browser-resolved final
              URLs).
            </p>
            <Tip>
              <strong>Rooster cheap → deep escalation.</strong> Stage 3 first
              runs three cheap signals on cached HTML: outgoing{' '}
              <Code>href</Code> domain match, <Code>&lt;img alt&gt;</Code>{' '}
              brand-name match, and image-filename token match
              (logo-spinjo.svg). If all three miss, score-row enqueues a{' '}
              <Code>rooster_deep</Code> follow-up that opens the page in
              Chromium, follows tracking redirects, and checks the resolved
              hostnames. This catches affiliates that cloak brand links
              behind /go/ redirects, without paying browser cost on
              first-pass hits.
            </Tip>
            <p>
              The score-row endpoint runs the stage logic and writes back to{' '}
              <Code>google_lead_gen_table</Code> — including the relevant{' '}
              <Code>*_checked_at</Code> timestamp on success. On permanent
              failure (max retries hit), the queue row goes to{' '}
              <Code>failed</Code> without a timestamp; the chain&apos;s blocked
              check treats failed rows as terminal so it can advance past them.
            </p>
            <Tip>
              The <strong>Force complete enrichment</strong> button in the{' '}
              <Code>/scrape</Code> kebab modal calls{' '}
              <Code>force_complete_enrichment(uuid)</Code>, which marks{' '}
              <Code>enrichment_status=&apos;complete&apos;</Code> immediately and
              cancels any pending/paused queue rows.
            </Tip>
          </Section>

          <Section id="schema" title="Database schema reference" icon={Database}>
            <p>
              Every table has RLS enabled with <em>no policies</em>, so anon
              and authenticated roles can&apos;t read or write directly — all
              access goes through the service-role client (which bypasses RLS)
              from server actions, API routes, and the workers.
            </p>
            <ReferenceTable
              headers={['Table', 'Purpose']}
              rows={[
                [
                  'scrape_queue',
                  'Work queue. status (pending|running|completed|failed|captcha|paused|cancelled), with_enrichment, language, scheduled_at, result_type_filter, enrichment_status.',
                ],
                [
                  'google_lead_gen_table',
                  'One row per scraped lead. Holds scrape output + every enrichment-stage column (is_affiliate, is_rooster_partner, has_contact_details, has_s_tags, *_checked_at timestamps, *_overridden_at timestamps).',
                ],
                [
                  'enrichment_fetch_queue',
                  'Per-stage work queue. process_stages jsonb, status (pending|running|completed|failed|paused|cancelled), want_html, want_screenshot.',
                ],
                [
                  's_tags_table',
                  'Per-lead extracted tracking tags. s_tag, source_param (btag|stag|cxd|mid|affid), brand, tracking_url, final_url, is_existing_on_monday, screenshot_path, redirect_chain.',
                ],
                [
                  'fetched_html_cache',
                  'One row per lead, latest fetch wins. Input to score-row stages.',
                ],
                [
                  'gologin_profiles',
                  '15 country profiles. country_code PK, gologin_profile_id, requires_google_login, is_google_logged_in, languages text[].',
                ],
                [
                  'rooster_brands',
                  'Editable list of partner brand domains. Active toggle, name, optional notes.',
                ],
                [
                  'scheduled_keyword_sets / _items',
                  'Recurring schedules. Cron expression on the set; one (keyword, country, pages) per item.',
                ],
                [
                  'active_profile_locks',
                  'Country lock; PK on country_code prevents two workers using the same profile. job_kind text discriminates scrape vs enrichment.',
                ],
                [
                  'batch_counter',
                  'Singleton row, source of get_next_batch_id().',
                ],
                [
                  'activity_log',
                  'Audit trail of UI mutations. action (dotted scheme), entity_type, entity_id, details jsonb.',
                ],
                [
                  'leads_table / affiliates_table / not_relevant_leads_table / email_undelivered_leads_table',
                  'Monday board mirror — synced via webhook + nightly cron.',
                ],
              ]}
            />
          </Section>

          <Section id="api" title="API endpoints" icon={Network}>
            <p>
              Most user actions go through Next.js server actions, not REST
              endpoints. The few real HTTP routes below exist for
              webhooks, cron, and worker callbacks.
            </p>
            <ReferenceTable
              headers={['Method', 'Path', 'Auth', 'Purpose']}
              rows={[
                [
                  'POST',
                  '/api/enrichment/score-row',
                  'Bearer INTERNAL_API_TOKEN',
                  'Workers call this after fetching HTML. Body: { stage, lead_id, html?, extras? }. Runs stage scorer, writes back to lead row.',
                ],
                [
                  'GET',
                  '/api/leads/[id]',
                  'Cookie session',
                  'Lead detail for the row drawer. Returns full enrichment payload + s-tags + screenshot URLs.',
                ],
                [
                  'POST',
                  '/api/monday/webhook',
                  'HS256 JWT (MONDAY_WEBHOOK_SECRET)',
                  'Monday.com event receiver. Handles create_item / change_column_value / item_deleted / create_update etc.',
                ],
                [
                  'GET, POST',
                  '/api/scheduler/tick',
                  'Bearer CRON_SECRET',
                  'Vercel cron, every minute. Spawns scrape rows from due scheduled_keyword_sets and advances the enrichment chain.',
                ],
                [
                  'GET, POST',
                  '/api/monday/sync',
                  'Bearer CRON_SECRET',
                  'Vercel cron, daily 23:00 UTC. Full re-sync of all 4 Monday boards into the Supabase mirror. maxDuration=300.',
                ],
              ]}
            />
            <p>
              Manual invocation example for the score-row endpoint:
            </p>
            <Pre>{`curl -X POST https://your-app.vercel.app/api/enrichment/score-row \\
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "stage": "affiliate",
    "lead_id": 12345,
    "html": "<html>…</html>"
  }'`}</Pre>
            <p>
              Manually trigger the Monday re-sync:
            </p>
            <Pre>{`curl -H "Authorization: Bearer $CRON_SECRET" \\
  https://your-app.vercel.app/api/monday/sync`}</Pre>
          </Section>

          <Section id="rpcs" title="Supabase RPCs" icon={FileCode}>
            <p>
              All RPCs are <Code>SECURITY DEFINER</Code> with{' '}
              <Code>search_path</Code> pinned to <Code>public</Code>. Only
              granted to the service role; <Code>anon</Code> and{' '}
              <Code>authenticated</Code> are revoked.
            </p>
            <ReferenceTable
              headers={['Function', 'Purpose']}
              rows={[
                ['get_next_batch_id()', 'Atomic batch-counter increment.'],
                [
                  'claim_scrape_job(worker_id)',
                  'Atomically claim a pending scrape with country-lock guarantee. Honors scheduled_at.',
                ],
                [
                  'complete_scrape_job(job_id, results, summary)',
                  'Atomic insert leads + mark complete + release country lock. Honors result_type_filter at insert time.',
                ],
                [
                  'captcha_scrape_job(job_id)',
                  'Mark captcha + release lock. No retry.',
                ],
                [
                  'fail_scrape_job(job_id, error)',
                  'Increment attempts; if < max, requeue; else mark failed. Releases lock.',
                ],
                [
                  'claim_enrichment_fetch_job(worker_id)',
                  'Same pattern as claim_scrape_job, but for enrichment_fetch_queue.',
                ],
                [
                  'complete_enrichment_fetch_job(job_id, html, screenshot_path, error)',
                  'Write fetched_html_cache row + update lead screenshot link + mark queue row.',
                ],
                [
                  'fail_enrichment_fetch_job(job_id, error)',
                  'Same retry semantics as fail_scrape_job.',
                ],
                [
                  'release_stale_locks(max_age_minutes)',
                  'pg_cron, every minute. Frees any active_profile_lock held > max_age_minutes (default 30).',
                ],
                [
                  'mark_monday_duplicates_for_job(job_id)',
                  'Pure DB Monday duplicate check across the 4 board mirrors + their updates.',
                ],
                [
                  'mark_s_tag_duplicates_for_job(job_id)',
                  'Cross-references each lead’s extracted tags against the Monday mirror.',
                ],
                [
                  'replace_s_tags_for_lead(lead_id, tags)',
                  'Atomic replace of s_tags_table rows for a lead.',
                ],
                [
                  'replace_and_verify_s_tags_for_lead(lead_id, tags)',
                  'Replace + dup-check + Rooster-brand cross-reference inline. Used by the s-tag stage.',
                ],
                [
                  'advance_enrichment_chain(job_id)',
                  'State machine driving the 6-stage enrichment chain. Called every minute by the scheduler tick.',
                ],
                [
                  'cancel_scrape_job(job_id)',
                  'Flip status to cancelled (pending/paused/running/failed/captcha) + cancel pending enrichment for this job.',
                ],
                [
                  'delete_scrape_job_cascade(job_id)',
                  'Wipe queue row + leads (cascades to s_tags / enrichment_fetch_queue / fetched_html_cache via FK ON DELETE CASCADE) + free locks.',
                ],
                [
                  'delete_leads_cascade(lead_ids)',
                  'Bulk lead delete (used by /leads bulk-select).',
                ],
                [
                  'force_complete_enrichment(job_id)',
                  'Manual escape hatch. Cancels pending/paused queue rows and marks enrichment complete immediately.',
                ],
              ]}
            />
            <p>
              <strong>Stage values that flow through the queue:</strong>{' '}
              <Code>affiliate</Code>, <Code>rooster</Code>,{' '}
              <Code>rooster_deep</Code> (auto-enqueued fallback when the
              cheap rooster check misses), <Code>contact</Code>,{' '}
              <Code>stag</Code>. The orchestrator advances the chain via{' '}
              <Code>advance_enrichment_chain</Code>; rooster_deep does not
              gate the chain — it runs alongside and silently corrects the
              flag if a brand link is found behind redirects.
            </p>
          </Section>

          <Section id="cron" title="Cron jobs" icon={Cog}>
            <ReferenceTable
              headers={['Source', 'Schedule', 'Path / function', 'Purpose']}
              rows={[
                [
                  'Vercel cron',
                  '* * * * *',
                  '/api/scheduler/tick',
                  'Every minute. Spawns scrape rows from due scheduled_keyword_sets, advances enrichment chains.',
                ],
                [
                  'Vercel cron',
                  '0 23 * * *',
                  '/api/monday/sync',
                  'Daily at 23:00 UTC. Full re-sync of all 4 Monday boards into the Supabase mirror.',
                ],
                [
                  'Supabase pg_cron',
                  '* * * * *',
                  'release_stale_locks(30)',
                  'Every minute. Frees country locks held > 30 min (crashed worker safety net).',
                ],
              ]}
            />
            <Tip>
              Vercel cron sends an <Code>Authorization: Bearer $CRON_SECRET</Code>{' '}
              header automatically when the env var is set on the project.
              Both internal cron paths verify it.
            </Tip>
          </Section>

          <Section id="env" title="Environment variables" icon={Settings}>
            <p>
              <strong>Vercel project:</strong>
            </p>
            <ReferenceTable
              headers={['Variable', 'Purpose']}
              rows={[
                ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase project URL (public)'],
                ['SUPABASE_SERVICE_ROLE_KEY', 'Service-role key for service-role client (bypasses RLS).'],
                ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Anon key for the cookie-aware client used by user sessions.'],
                ['MONDAY_API_TOKEN', 'Monday.com GraphQL token (read + write).'],
                ['MONDAY_WEBHOOK_SECRET', 'HS256 secret used to verify incoming webhook JWTs.'],
                ['OPENAI_API_KEY', 'GPT-4o (Responses API + web_search) for the contact cascade.'],
                ['HUNTER_API_KEY', 'Hunter.io domain-search fallback for contact extraction.'],
                ['CRON_SECRET', 'Bearer secret for /api/scheduler/tick and /api/monday/sync.'],
                ['INTERNAL_API_TOKEN', 'Bearer secret for /api/enrichment/score-row (workers → Vercel).'],
              ]}
            />
            <p>
              <strong>VM <Code>~/.env</Code>:</strong>
            </p>
            <ReferenceTable
              headers={['Variable', 'Purpose']}
              rows={[
                ['WORKER_ID', 'Set per systemd unit (vm1-9222, enrich-vm1-9225, etc.).'],
                ['GOLOGIN_PORT', 'Chrome debugger port — must be unique per concurrent worker (9222–9227).'],
                ['SUPABASE_URL', 'Same as NEXT_PUBLIC_SUPABASE_URL.'],
                ['SUPABASE_SERVICE_ROLE_KEY', 'For RPC calls from Python.'],
                ['INTERNAL_API_TOKEN', 'Used by enrichment_worker.py to call /api/enrichment/score-row.'],
                ['VERCEL_API_BASE', 'Base URL of the deployed Vercel app (e.g. https://lead-gen.vercel.app).'],
                ['OPENAI_API_KEY', 'Used by the score-row endpoint, but mirrored on the VM if any local fallback runs.'],
                ['GOLOGIN_TOKEN', 'GoLogin API token used to start profiles by ID.'],
                ['SCRAPER_PATH', 'Path to ~/scraper.py (default).'],
                ['KILL_SCRIPT_PATH', 'Path to ~/kill_gologin.py.'],
                ['SCRAPE_TIMEOUT_SECONDS', 'Scrape subprocess timeout (default 1200s).'],
                ['POLL_INTERVAL_SECONDS', 'How often the worker polls for new jobs (default 5).'],
              ]}
            />
            <Tip>
              Never commit secrets. The VM&apos;s <Code>.env</Code> is in{' '}
              <Code>/home/ubuntu/.env</Code> and loaded by each systemd unit.
            </Tip>
          </Section>

          <Section id="vm" title="VM deployment" icon={Server}>
            <p>
              The VMs hold individual scripts (not a full repo clone). Update
              one file at a time by curl-ing the raw GitHub URL into the
              user&apos;s home dir, then restart the service.
            </p>
            <p>
              <strong>Pull a worker file:</strong>
            </p>
            <Pre>{`# scrape worker
curl -fsSL https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/worker.py \\
  -o ~/worker.py

# enrichment worker
curl -fsSL https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/enrichment_worker.py \\
  -o ~/enrichment_worker.py`}</Pre>
            <p>
              <strong>Edit the legacy scraper</strong> (<Code>~/scraper.py</Code>{' '}
              is VM-only, not in the repo):
            </p>
            <Pre>{`nano ~/scraper.py
# make the change, then Ctrl+O, Enter, Ctrl+X`}</Pre>
            <p>
              <strong>Restart workers:</strong>
            </p>
            <Pre>{`sudo systemctl restart 'scrape-worker@*'      # 9222/3/4
sudo systemctl restart 'enrichment-worker@*'  # 9225/6/7

# verify
sudo systemctl status 'scrape-worker@*' --no-pager
sudo systemctl status 'enrichment-worker@*' --no-pager

# tail one
journalctl -u 'scrape-worker@9222' -f`}</Pre>
            <p>
              <strong>List units:</strong> when in doubt about service names,
            </p>
            <Pre>{`sudo systemctl list-units --type=service --all | grep -Ei 'worker|gologin'`}</Pre>
          </Section>

          <Section id="migrations" title="Database migrations" icon={GitBranch}>
            <p>
              Migrations are timestamped SQL files in{' '}
              <Code>supabase/migrations/</Code>. Apply them in order. The
              project uses raw SQL (no Supabase CLI workflow assumed).
            </p>
            <p>
              <strong>Easiest path</strong> — Supabase Dashboard → SQL editor →
              paste the migration content → Run. Works for all migrations.
            </p>
            <p>
              <strong>CLI path</strong>:
            </p>
            <Pre>{`# from the project root
supabase db push   # if you've linked the project

# or run a single file via psql directly
PGPASSWORD=… psql "host=db.<ref>.supabase.co user=postgres dbname=postgres" \\
  < supabase/migrations/20260429060000_scrape_language.sql`}</Pre>
            <p>
              Recent migrations to be aware of:
            </p>
            <ul>
              <li>
                <Code>20260429030000_pause_cancel_delete.sql</Code> — pause /
                cancel / delete RPCs and status enums.
              </li>
              <li>
                <Code>20260429040000_unstall_enrichment_chain.sql</Code> — fix
                for the orchestrator stalling on permanently-failed rows + adds{' '}
                <Code>force_complete_enrichment</Code>.
              </li>
              <li>
                <Code>20260429050000_scrape_result_type_filter.sql</Code> —{' '}
                <Code>result_type_filter</Code> column on scrape_queue.
              </li>
              <li>
                <Code>20260429060000_scrape_language.sql</Code> — per-country
                language list + per-job language code.
              </li>
            </ul>
            <Tip>
              All RPCs use <Code>create or replace function</Code>, so applying
              the same migration twice is safe — last one wins.
            </Tip>
          </Section>

          <Section id="troubleshoot" title="Troubleshooting" icon={AlertTriangle}>
            <p>
              <strong>Enrichment is stuck on &quot;all_running&quot; for hours.</strong>
            </p>
            <ul>
              <li>
                Open the kebab on the job &rarr; Enrichment section &rarr; Force
                complete. This cancels any pending queue rows and marks the
                chain complete.
              </li>
              <li>
                Apply migration <Code>20260429040000</Code> if you haven&apos;t
                — the older orchestrator stalled on permanently-failed rows.
              </li>
            </ul>
            <p>
              <strong>Scrape repeatedly hits CAPTCHA for a country.</strong>
            </p>
            <ul>
              <li>
                The country&apos;s residential proxy IP probably got flagged.
                Try a different country profile, or wait a few hours.
              </li>
              <li>
                For PPC-required countries (NZ, UK, AU), make sure{' '}
                <Code>is_google_logged_in=true</Code> on{' '}
                <Code>/profiles</Code>. Logged-out browsers on those countries
                trigger CAPTCHA almost immediately.
              </li>
            </ul>
            <p>
              <strong>Worker not picking up jobs.</strong>
            </p>
            <ul>
              <li>
                <Code>sudo systemctl status &apos;scrape-worker@*&apos;</Code>{' '}
                — confirm units are <Code>active (running)</Code>.
              </li>
              <li>
                <Code>journalctl -u &apos;scrape-worker@9222&apos; -f</Code> to
                tail.
              </li>
              <li>
                Check <Code>active_profile_locks</Code> for stale rows. The
                pg_cron <Code>release_stale_locks(30)</Code> clears anything
                held &gt; 30 min, but you can run it manually:{' '}
                <Code>select release_stale_locks(0)</Code> to force-clear.
              </li>
            </ul>
            <p>
              <strong>Monday data feels behind.</strong>
            </p>
            <ul>
              <li>
                Trigger the manual re-sync:{' '}
                <Code>npm run monday:sync</Code> locally, or hit{' '}
                <Code>/api/monday/sync</Code> with the bearer token.
              </li>
              <li>
                Check the webhook receiver logs in Vercel for any 4xx/5xx
                responses.
              </li>
            </ul>
            <p>
              <strong>Login warning persists for a country I just signed in.</strong>
            </p>
            <ul>
              <li>
                On <Code>/profiles</Code>, flip <Code>is_google_logged_in</Code>{' '}
                manually after the GoLogin session has the cookie.
              </li>
            </ul>
            <p>
              <strong>Manual Google-login flips back to logged-out on its own.</strong>
            </p>
            <ul>
              <li>
                Migration <Code>20260429080000</Code> protects manual TRUE
                from auto-detect false positives. If you applied it,
                manual confirmations now stick — <Code>complete_scrape_job</Code>{' '}
                only auto-flips false→true (confirms sign-ins) and won&apos;t
                drop a manual TRUE down to FALSE.
              </li>
              <li>
                Real logouts still show as a stale{' '}
                <Code>google_login_verified_at</Code> on{' '}
                <Code>/profiles</Code> — re-sign-in via GoLogin and re-flip
                the toggle.
              </li>
            </ul>
            <p>
              <strong>Rooster brand says NO on a site that lists our brands.</strong>
            </p>
            <ul>
              <li>
                The page might hide brand links behind tracking redirects
                (/go/, ?dest=). With migration <Code>20260429070000</Code>{' '}
                applied + the latest enrichment_worker.py on the VMs,{' '}
                <Code>rooster_deep</Code> auto-enqueues on every
                cheap-check miss and resolves redirects in browser to
                check the final hostnames.
              </li>
              <li>
                Stage 3 also catches brand mentions in{' '}
                <Code>&lt;img alt=&quot;Brand&quot;&gt;</Code> attributes
                and image filenames (e.g. <Code>logo-spinjo.svg</Code>).
              </li>
              <li>
                If still no — verify the brand is in the{' '}
                <Code>rooster_brands</Code> table with{' '}
                <Code>is_active=true</Code> and the right{' '}
                <Code>domain</Code>.
              </li>
            </ul>
            <p>
              <strong>Filter / sort URL stops working after refactor.</strong>
            </p>
            <ul>
              <li>
                Advanced filters live in <Code>?f=</Code> and <Code>?s=</Code>{' '}
                URL params. If you copied a URL before the filter widget
                landed (anything before commit <Code>9beec22</Code>), the
                old <Code>?country_code=</Code> /{' '}
                <Code>?result_type=</Code> params still work as a
                preserve-list — the new widget reads / writes{' '}
                <Code>?f=</Code>/<Code>?s=</Code> but old URLs aren&apos;t
                broken.
              </li>
            </ul>
            <p>
              <strong>Scrape language not taking effect.</strong>
            </p>
            <ul>
              <li>
                Confirm the VM&apos;s <Code>~/scraper.py</Code> has{' '}
                <Code>--language</Code> in its argparse and{' '}
                <Code>&hl=&#123;language&#125;</Code> in the URL builder.
              </li>
              <li>
                Confirm <Code>~/worker.py</Code> on the VM is the latest one
                from the repo (it forwards <Code>--language</Code> to the
                subprocess).
              </li>
              <li>
                Tail the worker log and look for{' '}
                <Code>lang=&lt;code&gt;</Code> in the &quot;claimed job&quot;
                line.
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  icon: Icon,
  children,
}: {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4"
    >
      <header className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-[color:var(--color-accent)]" />
        <h2 className="text-[15px] font-semibold text-[color:var(--color-text-primary)]">
          {title}
        </h2>
      </header>
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-[color:var(--color-text-primary)] [&_li]:marker:text-[color:var(--color-text-secondary)] [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[color:var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px] text-[color:var(--color-text-primary)]">
      {children}
    </code>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--color-text-primary)]">
      {children}
    </pre>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border-l-2 border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 px-3 py-2 text-[12px] text-[color:var(--color-text-primary)]">
      💡 {children}
    </p>
  )
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-accent)]/20 text-[10px] font-semibold text-[color:var(--color-text-primary)]">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

function ReferenceTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: string[][]
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr>
            {headers.map(h => (
              <th
                key={h}
                scope="col"
                className="border-b border-[color:var(--color-border)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]/50"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={[
                    'px-3 py-2 align-top',
                    ci === 0 ? 'font-mono text-[11px]' : '',
                  ].join(' ')}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
