'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  Circle,
  Clock,
  Cpu,
  Database,
  Edit3,
  Globe,
  ListChecks,
  Pause,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Workflow,
} from 'lucide-react'

const STORAGE_KEY = 'lg-onboarding-completed'

type SectionDef = {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
}

const SECTIONS: SectionDef[] = [
  { id: 'welcome', title: 'Welcome', icon: Sparkles },
  { id: 'scrape', title: 'Set up a scrape', icon: Search },
  { id: 'lifecycle', title: 'Job lifecycle', icon: Activity },
  { id: 'manage', title: 'Pause / Cancel / Delete', icon: Pause },
  { id: 'rerun', title: 'Re-run a job', icon: RotateCcw },
  { id: 'enrichment', title: 'Enrichment pipeline', icon: Workflow },
  { id: 'leads', title: 'Working with leads', icon: ListChecks },
  { id: 'overrides', title: 'Manual overrides', icon: Edit3 },
  { id: 'schedules', title: 'Recurring schedules', icon: CalendarClock },
  { id: 'profiles', title: 'Profiles & languages', icon: Globe },
  { id: 'brands', title: 'Rooster brands', icon: Star },
  { id: 'activity', title: 'Activity log', icon: Clock },
  { id: 'workers', title: 'Workers & health', icon: Cpu },
  { id: 'monday', title: 'Monday data', icon: Database },
]

function useCompleted() {
  const [completed, setCompleted] = useState<Set<string>>(new Set())

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      // One-shot hydration from persisted state on mount; the lint rule
      // is a generic warning against setState in effects, but "load
      // saved state once" is exactly what useEffect is for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setCompleted(new Set(JSON.parse(raw) as string[]))
    } catch {
      /* localStorage unavailable */
    }
  }, [])

  const persist = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)))
    } catch {
      /* ignore */
    }
  }, [])

  const toggle = useCallback(
    (id: string) => {
      setCompleted(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        persist(next)
        return next
      })
    },
    [persist],
  )

  const reset = useCallback(() => {
    setCompleted(new Set())
    persist(new Set())
  }, [persist])

  return { completed, toggle, reset }
}

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
      { rootMargin: '-30% 0px -55% 0px', threshold: 0 },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [ids])
  return active
}

export default function OnboardingPage() {
  const { completed, toggle, reset } = useCompleted()
  const ids = useMemo(() => SECTIONS.map(s => s.id), [])
  const active = useScrollSpy(ids)
  const progress = Math.round((completed.size / SECTIONS.length) * 100)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[color:var(--color-accent)]" />
          <h1 className="text-[18px] font-semibold text-[color:var(--color-text-primary)]">
            Onboarding & feature tour
          </h1>
        </div>
        <p className="max-w-3xl text-[13px] text-[color:var(--color-text-secondary)]">
          Everything this app does, in plain English. Click through each section to
          learn what a feature does, why it exists, and where to find it. Tick
          sections off as you read — your progress stays in this browser.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-2 w-48 overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
            <div
              className="h-full bg-[color:var(--color-accent)] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[12px] text-[color:var(--color-text-secondary)]">
            {completed.size} of {SECTIONS.length} done · {progress}%
          </span>
          {completed.size > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-[11px] text-[color:var(--color-text-secondary)] underline-offset-2 hover:underline"
            >
              Reset progress
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        {/* TOC */}
        <aside className="md:sticky md:top-4 md:self-start">
          <nav className="flex flex-col gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2">
            {SECTIONS.map((s, i) => {
              const Icon = s.icon
              const done = completed.has(s.id)
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
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  )}
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">
                    {i + 1}. {s.title}
                  </span>
                </a>
              )
            })}
          </nav>
        </aside>

        {/* Sections */}
        <div className="flex flex-col gap-6">
          <Section
            id="welcome"
            title="Welcome to Lead Gen"
            icon={Sparkles}
            done={completed.has('welcome')}
            onToggle={() => toggle('welcome')}
            next="scrape"
          >
            <p>
              This app finds high-quality affiliate-leads for Rooster by scraping
              Google search results across 15 countries, then running each lead
              through a six-stage enrichment pipeline. The end product is a
              short-list of websites that look like real affiliates and aren&apos;t
              already on your Monday boards.
            </p>
            <ul>
              <li>
                <strong>Scrape</strong> a keyword in a country (and optionally a
                language) → lands as Organic + PPC rows.
              </li>
              <li>
                <strong>Enrich</strong> each row through six stages — checks for
                duplicates, affiliate signals, partner brands, contact info,
                tracking-tags.
              </li>
              <li>
                <strong>Review</strong> on the Leads page, override anything the
                automation got wrong, and ship the keepers to Monday.
              </li>
            </ul>
            <Tip>
              The dashboard at <Code>/</Code> shows live KPIs, what each worker is
              doing right now, and the most recent batches. Always start there.
            </Tip>
            <TryItRow>
              <TryIt href="/" label="Open the dashboard" />
            </TryItRow>
          </Section>

          <Section
            id="scrape"
            title="Setting up a scrape"
            icon={Search}
            done={completed.has('scrape')}
            onToggle={() => toggle('scrape')}
            prev="welcome"
            next="lifecycle"
          >
            <p>
              Submitting a scrape on <Code>/scrape</Code> queues one job per
              keyword. A VM worker picks it up within ~5 seconds, opens a real
              Chromium browser through GoLogin (with the country&apos;s residential
              proxy), and writes the results back into Supabase.
            </p>
            <ul>
              <li>
                <strong>Keywords</strong> — paste one per line; each becomes its
                own job. Up to 500 chars each.
              </li>
              <li>
                <strong>Country</strong> — picks the GoLogin profile and proxy
                location. Profiles flagged{' '}
                <span className="text-amber-700">⚠ needs login</span> mean
                Google requires a logged-in account before serving PPC ads
                there.
              </li>
              <li>
                <strong>Search language</strong> — sets <Code>&hl=</Code> on the
                Google URL. Defaults to <Code>en</Code>; the dropdown filters to
                languages valid for the chosen country.
              </li>
              <li>
                <strong>Pages</strong> — 1 to 10. Each page = ~10 organic
                results plus any PPC ads.
              </li>
              <li>
                <strong>Priority</strong> — higher numbers get claimed sooner
                when workers are idle.
              </li>
              <li>
                <strong>Run full enrichment after scrape</strong> — when ticked,
                an orchestrator auto-fires all six enrichment stages once
                scraping finishes.
              </li>
              <li>
                <strong>Schedule for…</strong> — leave blank to run now, or pick
                a future date/time. Workers won&apos;t claim it until then.
              </li>
            </ul>
            <Tip>
              For Oman / UAE / Saudi etc., switching the language to{' '}
              <Code>ar</Code> dramatically changes the SERP — you&apos;ll see
              local-language affiliates the English search misses.
            </Tip>
            <TryItRow>
              <TryIt href="/scrape" label="Open the scrape form" />
            </TryItRow>
          </Section>

          <Section
            id="lifecycle"
            title="Job lifecycle & status badges"
            icon={Activity}
            done={completed.has('lifecycle')}
            onToggle={() => toggle('lifecycle')}
            prev="scrape"
            next="manage"
          >
            <p>
              Every queued scrape walks through a defined set of states. The
              status pill in the <Code>/scrape</Code> table reflects both scrape
              and enrichment progress in one badge so you can see at a glance
              what&apos;s happening.
            </p>
            <ul>
              <li>
                <Badge tone="neutral">pending</Badge> — waiting for an idle
                worker.
              </li>
              <li>
                <Badge tone="info">running</Badge> — a worker is actively
                scraping.
              </li>
              <li>
                <Badge tone="purple">paused</Badge> — you paused it; workers
                will skip until resumed.
              </li>
              <li>
                <Badge tone="amber">enrichment queued</Badge> — scrape done,
                orchestrator hasn&apos;t spun up enrichment yet.
              </li>
              <li>
                <Badge tone="sky">enriching · affiliate</Badge> /{' '}
                <Badge tone="sky">enriching · all stages</Badge> — enrichment is
                running.
              </li>
              <li>
                <Badge tone="success">completed</Badge> — scrape <em>and</em>{' '}
                enrichment fully done.
              </li>
              <li>
                <Badge tone="amber">captcha</Badge> — Google blocked the
                worker; you may need to re-run with a different country.
              </li>
              <li>
                <Badge tone="danger">failed</Badge> — terminal failure after max
                retries.
              </li>
              <li>
                <Badge tone="neutral">cancelled</Badge> — you cancelled it.
              </li>
            </ul>
            <Tip>
              The page auto-refreshes every 5s while anything is in flight, so
              you can watch a job progress in real time without reloading.
            </Tip>
          </Section>

          <Section
            id="manage"
            title="Pause / Resume / Cancel / Delete"
            icon={Pause}
            done={completed.has('manage')}
            onToggle={() => toggle('manage')}
            prev="lifecycle"
            next="rerun"
          >
            <p>
              The kebab (⋮) at the start of every row on <Code>/scrape</Code>{' '}
              opens a management modal. What appears in the modal depends on the
              job&apos;s current state.
            </p>
            <ul>
              <li>
                <strong>Pause</strong> a pending job to free the worker for
                other work — your job sits in <Code>paused</Code> until you
                resume it.
              </li>
              <li>
                <strong>Resume</strong> flips paused → pending; the next idle
                worker picks it up.
              </li>
              <li>
                <strong>Pause / Resume enrichment</strong> appears for jobs
                whose enrichment chain is in flight. Pausing flips every
                pending enrichment row to <Code>paused</Code>; rows already
                running finish naturally.
              </li>
              <li>
                <strong>Force complete enrichment</strong> — escape hatch when
                the chain stalls on permanently-failed domains. Cancels any
                pending queue rows and marks enrichment <Code>complete</Code>.
              </li>
              <li>
                <strong>Cancel</strong> — soft cancel; the row is marked but
                in-flight scrape work isn&apos;t aborted mid-page.
              </li>
              <li>
                <strong>Delete</strong> — irreversible. Wipes the queue row,
                every lead it spawned, all s-tags, all enrichment-queue rows,
                cached HTML, and screenshots.
              </li>
            </ul>
            <Tip>
              Cancel and Delete both require typing the exact keyword to
              confirm — protects against accidental clicks.
            </Tip>
            <TryItRow>
              <TryIt href="/scrape" label="Find a job and open the kebab" />
            </TryItRow>
          </Section>

          <Section
            id="rerun"
            title="Re-running a job (filtered)"
            icon={RotateCcw}
            done={completed.has('rerun')}
            onToggle={() => toggle('rerun')}
            prev="manage"
            next="enrichment"
          >
            <p>
              Sometimes a scrape&apos;s organic results came back fine but the
              PPC capture was empty (or vice versa). Instead of re-running the
              whole batch, the kebab modal has buttons to queue a fresh scrape
              that <em>only keeps one result type</em>.
            </p>
            <ul>
              <li>
                <strong>Re-run — PPC only</strong> queues a new scrape_queue row
                with <Code>result_type_filter=&apos;PPC&apos;</Code>. Filtering
                happens at insert time inside <Code>complete_scrape_job</Code>,
                so only PPC rows land.
              </li>
              <li>
                <strong>Re-run — Organic only</strong> — same, for organic
                results.
              </li>
              <li>
                Buttons are visible only on <Code>completed</Code>,{' '}
                <Code>failed</Code>, <Code>captcha</Code>, and{' '}
                <Code>cancelled</Code> jobs (re-running mid-flight would race).
              </li>
            </ul>
            <Tip>
              The Results column on <Code>/scrape</Code> shows the breakdown as{' '}
              <Code>123 (12 PPC · 111 Org)</Code> so you can spot a missing
              capture at a glance.
            </Tip>
          </Section>

          <Section
            id="enrichment"
            title="The enrichment pipeline"
            icon={Workflow}
            done={completed.has('enrichment')}
            onToggle={() => toggle('enrichment')}
            prev="rerun"
            next="leads"
          >
            <p>
              Six stages run on each lead, in order. Each one writes back to{' '}
              <Code>google_lead_gen_table</Code> via the{' '}
              <Code>/api/enrichment/score-row</Code> endpoint. You can also
              trigger any stage manually from the job detail page.
            </p>
            <ol>
              <li>
                <strong>1. Monday duplicate check</strong> — pure DB query
                against the Monday replica tables. No fetch needed; sets{' '}
                <Code>is_on_monday</Code>.
              </li>
              <li>
                <strong>2. Affiliate detection</strong> — fetches the lead&apos;s
                homepage in a browser, scores it for affiliate signals
                (out-bound tracking links, casino keywords, sponsored language).
                Sets <Code>is_affiliate</Code> + confidence.
              </li>
              <li>
                <strong>3. Rooster partner check</strong> — runs three
                cheap signals against the cached HTML: outgoing{' '}
                <Code>href</Code> match against brand domains,{' '}
                <Code>&lt;img alt=&quot;Brand&quot;&gt;</Code> match,
                and image filename token match (logo-spinjo.svg). If
                none of those hit, escalates to a{' '}
                <Code>rooster_deep</Code> follow-up that opens the page in
                Chromium, follows tracking redirects, and checks the
                resolved hostnames against the brand list — catching
                affiliates that hide brand links behind /go/ redirects.
              </li>
              <li>
                <strong>4. Contact extraction</strong> — visits homepage,{' '}
                <Code>/contact</Code>, <Code>/about</Code>, <Code>/impressum</Code>{' '}
                and runs a cascade: regex → GPT-4o web search → Hunter.io
                fallback.
              </li>
              <li>
                <strong>5. S-tag extraction</strong> (affiliate rows only) —
                follows tracking links, takes a screenshot of each landing,
                pulls out <Code>btag</Code> / <Code>stag</Code> / <Code>cxd</Code>{' '}
                / <Code>mid</Code> / <Code>affid</Code> params.
              </li>
              <li>
                <strong>6. S-tag verify</strong> — cross-references each
                extracted tag against the Monday replica to flag duplicates.
              </li>
            </ol>
            <Tip>
              The pipeline badges on the jobs table (small circles in the
              Pipeline column) show which stages have run for each job.
            </Tip>
          </Section>

          <Section
            id="leads"
            title="Working with leads"
            icon={ListChecks}
            done={completed.has('leads')}
            onToggle={() => toggle('leads')}
            prev="enrichment"
            next="overrides"
          >
            <p>
              <Code>/leads</Code> is the one-table view of every scraped lead.
              It mirrors the <Code>google_lead_gen_table</Code> with all
              enrichment columns, monday.com-style advanced filters, multi-key
              sort, search, and per-row actions.
            </p>
            <ul>
              <li>
                <strong>PPC at top</strong> — results group by{' '}
                <Code>result_type</Code> with PPC above Organic. Within each
                group, the column you click sorts.
              </li>
              <li>
                <strong>Search</strong> — free-text across keyword / URL /
                domain / country (Enter or blur to commit).
              </li>
              <li>
                <strong>Filter button</strong> — popover with multi-row
                conditions: column dropdown, type-aware operator (text gets
                contains / starts-with / is-empty; numbers get =/{'≠'}/{'>'}/between;
                dates get is-before/is-after/between; booleans + selects get
                a value picker). All conditions are AND-joined. Active
                filters appear as removable chips above the table.
              </li>
              <li>
                <strong>Sort button</strong> — multi-key priority sort. First
                key is primary, subsequent keys are tiebreakers. Each key has
                its own asc/desc toggle.
              </li>
              <li>
                <strong>Bookmarkable URLs</strong> — every filter, sort, and
                search persists in{' '}
                <Code>?f=</Code> /<Code>?s=</Code> /<Code>?q=</Code> URL
                params, so you can share a saved view by copy-pasting the link.
              </li>
              <li>
                <strong>Domain link</strong> — clicking a domain opens the lead
                detail drawer with the full enrichment payload, screenshot,
                detected s-tags, and contact info.
              </li>
              <li>
                <strong>Select rows</strong> — toggle in the toolbar reveals a
                checkbox column. Once 1+ are selected, a sticky action bar
                appears at the top of the table.
              </li>
              <li>
                <strong>Bulk retry</strong> — the bar&apos;s Affiliate /
                Rooster / Contact / S-tags buttons re-enqueue the selected
                leads for any single enrichment stage. Great for retrying a
                handful of failed domains.
              </li>
              <li>
                <strong>Bulk delete</strong> — wipes the selected leads + their
                s-tags + enrichment + screenshots. Requires typing{' '}
                <Code>delete N</Code> (where N = the count) to confirm.
              </li>
            </ul>
            <Tip>
              Same advanced filter widget lives on{' '}
              <Code>/scrape</Code> (filter the jobs table) and{' '}
              <Code>/scrape/[id]</Code> (filter that job&apos;s leads), so the
              workflow is identical wherever you have a table.
            </Tip>
            <TryItRow>
              <TryIt href="/leads" label="Open Leads" />
            </TryItRow>
          </Section>

          <Section
            id="overrides"
            title="Manual overrides"
            icon={Edit3}
            done={completed.has('overrides')}
            onToggle={() => toggle('overrides')}
            prev="leads"
            next="schedules"
          >
            <p>
              Every boolean enrichment flag (Is on Monday, Is an affiliate,
              Rooster brand, Has contacts, S-tags, Verified s-tags) has an
              inline editor on the leads table. Setting any of them stamps an{' '}
              <Code>*_overridden_at</Code> timestamp so the orchestrator
              skips that stage for that lead going forward.
            </p>
            <ul>
              <li>
                <strong>Yes / No</strong> — locks the flag manually; auto-runs
                won&apos;t touch it again.
              </li>
              <li>
                <strong>Clear</strong> — removes the override, putting the lead
                back into the pool for the next auto-run.
              </li>
              <li>
                Use overrides when the model is wrong, or when you want to
                exclude a specific domain from re-enrichment.
              </li>
            </ul>
          </Section>

          <Section
            id="schedules"
            title="Recurring schedules"
            icon={CalendarClock}
            done={completed.has('schedules')}
            onToggle={() => toggle('schedules')}
            prev="overrides"
            next="profiles"
          >
            <p>
              <Code>/schedules</Code> lets you pre-configure a set of
              keyword/country/pages combinations and have the system run them
              on a cron expression. Useful for daily / weekly market scans.
            </p>
            <ul>
              <li>
                <strong>Set</strong> — one named bundle with a cron expression
                (e.g. <Code>0 9 * * 1</Code> for Mondays at 9 UTC).
              </li>
              <li>
                <strong>Items</strong> — one (keyword, country, pages) per row
                inside a set. Each fires a separate scrape job when the cron
                triggers.
              </li>
              <li>
                <strong>Run enrichment</strong> — checkbox on the set; when
                ticked, every spawned job has{' '}
                <Code>with_enrichment=true</Code> and auto-runs the full chain.
              </li>
              <li>
                The scheduler tick (Vercel cron, every minute) finds due sets
                and inserts queue rows.
              </li>
            </ul>
            <TryItRow>
              <TryIt href="/schedules" label="Manage schedules" />
            </TryItRow>
          </Section>

          <Section
            id="profiles"
            title="Country profiles & languages"
            icon={Globe}
            done={completed.has('profiles')}
            onToggle={() => toggle('profiles')}
            prev="schedules"
            next="brands"
          >
            <p>
              <Code>/profiles</Code> manages the 15 GoLogin country profiles —
              one per country, each with a country-matched residential proxy.
              Some countries (NZ, UK, AU) require a logged-in Google account
              before PPC ads will render reliably.
            </p>
            <ul>
              <li>
                <strong>Requires Google login</strong> — auto-set for countries
                that empirically need it. Manual toggle if you spot one we
                missed.
              </li>
              <li>
                <strong>Is logged in</strong> — flip to <Code>true</Code> after
                you&apos;ve signed in via the GoLogin app on the VM. The
                scrape form&apos;s country dropdown shows{' '}
                <span className="text-amber-700">⚠ needs login</span> until
                this is true.
              </li>
              <li>
                <strong>Languages</strong> — array of ISO 639-1 codes valid for
                that country. Drives the Search-language dropdown in the
                scrape form. EN is included as a fallback everywhere.
              </li>
            </ul>
            <Tip>
              Manual TRUE is sticky against false-positive auto-detections.
              If a scrape&apos;s login detector misreads a logged-in session as
              logged-out (layout variants, cookie banners), it can no longer
              wipe your manual confirmation. Real logouts still surface via
              the <Code>google_login_verified_at</Code> timestamp on this
              page.
            </Tip>
            <TryItRow>
              <TryIt href="/profiles" label="Manage profiles" />
            </TryItRow>
          </Section>

          <Section
            id="brands"
            title="Rooster brands"
            icon={Star}
            done={completed.has('brands')}
            onToggle={() => toggle('brands')}
            prev="profiles"
            next="activity"
          >
            <p>
              <Code>/brands</Code> is the editable list of Rooster partner
              domains. The Rooster check stage searches each lead&apos;s page
              content and outgoing links for any of the active domains here.
            </p>
            <ul>
              <li>
                <strong>Add / edit / delete</strong> — domain + display name +
                optional notes.
              </li>
              <li>
                <strong>Active toggle</strong> — flip to <Code>false</Code> to
                exclude a brand from the check without deleting its history.
              </li>
              <li>
                Edits take effect immediately — the next enrichment run pulls
                the active list fresh.
              </li>
            </ul>
            <TryItRow>
              <TryIt href="/brands" label="Manage Rooster brands" />
            </TryItRow>
          </Section>

          <Section
            id="activity"
            title="Activity log"
            icon={Clock}
            done={completed.has('activity')}
            onToggle={() => toggle('activity')}
            prev="brands"
            next="workers"
          >
            <p>
              <Code>/activity</Code> is the searchable audit trail. Every UI
              mutation lands here — scrape enqueues, manual overrides, brand
              edits, profile toggles, screenshot deletes, scrape cancellations
              and deletions, bulk leads operations, the lot.
            </p>
            <ul>
              <li>
                <strong>Filter chips</strong> at the top group actions by
                family (Scrape / Enrichment / Override / Brand / Profile /
                Schedule / Screenshot).
              </li>
              <li>
                <strong>Search</strong> by user email, entity ID, or entity
                type.
              </li>
              <li>
                Each row shows who did what, when, and the relevant details
                (e.g. enqueued counts, prior-status, deleted-lead counts).
              </li>
              <li>
                Activity rows survive scrape-job deletion — you keep the audit
                trail even after the job is gone.
              </li>
            </ul>
            <TryItRow>
              <TryIt href="/activity" label="Open activity log" />
            </TryItRow>
          </Section>

          <Section
            id="workers"
            title="Workers & system health"
            icon={Cpu}
            done={completed.has('workers')}
            onToggle={() => toggle('workers')}
            prev="activity"
            next="monday"
          >
            <p>
              The dashboard at <Code>/</Code> shows a live grid of all six VM
              workers — three scrape (ports 9222/3/4) and three enrichment
              (9225/6/7). Busy slots show what they&apos;re currently working
              on; idle slots show <em>vacant — waiting for work</em>.
            </p>
            <ul>
              <li>
                <strong>Spinning green dot</strong> = worker actively
                processing.
              </li>
              <li>
                <strong>Gray dot</strong> = idle.
              </li>
              <li>
                Busy cards show the keyword (or URL for enrichment), country,
                stages, and elapsed time since claim.
              </li>
              <li>
                The dashboard auto-refreshes every 5s while any worker is busy
                or any job is in flight.
              </li>
            </ul>
            <Tip>
              If a worker stays busy on the same row for &gt; 30 minutes,{' '}
              <Code>release_stale_locks</Code> (pg_cron, every minute)
              automatically frees the country lock so other jobs can use it.
            </Tip>
          </Section>

          <Section
            id="monday"
            title="Monday data"
            icon={Database}
            done={completed.has('monday')}
            onToggle={() => toggle('monday')}
            prev="workers"
          >
            <p>
              <Code>/monday/leads</Code> mirrors four Monday boards (Leads,
              Affiliates, Not-Relevant Leads, Email-Undelivered Leads) into
              Supabase. The mirror is what powers the Monday duplicate check
              and the s-tag verification stage.
            </p>
            <ul>
              <li>
                <strong>Webhooks</strong> — Monday pushes each
                create/update/delete event to <Code>/api/monday/webhook</Code>{' '}
                in real time.
              </li>
              <li>
                <strong>Nightly re-sync</strong> — Vercel cron at 23:00 UTC
                hits <Code>/api/monday/sync</Code> as a safety net for missed
                webhook events. Full re-sync of all four boards.
              </li>
              <li>
                <strong>Manual sync</strong> — run{' '}
                <Code>npm run monday:sync</Code> locally any time the mirror
                feels behind.
              </li>
            </ul>
            <TryItRow>
              <TryIt href="/monday/leads" label="Browse Monday data" />
            </TryItRow>
            <Tip>
              You&apos;ve reached the end of the tour. Hit Reset progress at
              the top if you want to start over.
            </Tip>
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
  done,
  onToggle,
  prev,
  next,
  children,
}: {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
  done: boolean
  onToggle: () => void
  prev?: string
  next?: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[color:var(--color-accent)]" />
          <h2 className="text-[15px] font-semibold text-[color:var(--color-text-primary)]">
            {title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className={[
            'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
            done
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
              : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]',
          ].join(' ')}
        >
          {done ? <CheckSquare className="h-3 w-3" /> : <CheckSquare className="h-3 w-3 opacity-40" />}
          {done ? 'Marked done' : 'Mark done'}
        </button>
      </header>
      <div className="prose-styles flex flex-col gap-3 text-[13px] leading-relaxed text-[color:var(--color-text-primary)] [&_li]:marker:text-[color:var(--color-text-secondary)] [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:text-[color:var(--color-text-primary)] [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
      {(prev || next) && (
        <footer className="mt-4 flex items-center justify-between border-t border-[color:var(--color-border)] pt-3 text-[12px]">
          {prev ? (
            <a
              href={`#${prev}`}
              className="inline-flex items-center gap-1 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              ← Previous
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a
              href={`#${next}`}
              className="inline-flex items-center gap-1 font-medium text-[color:var(--color-accent-hover)] hover:underline"
            >
              Next: {labelFor(next)} <ArrowRight className="h-3 w-3" />
            </a>
          ) : (
            <span />
          )}
        </footer>
      )}
    </section>
  )
}

function labelFor(id: string): string {
  return SECTIONS.find(s => s.id === id)?.title ?? id
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[color:var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px] text-[color:var(--color-text-primary)]">
      {children}
    </code>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border-l-2 border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 px-3 py-2 text-[12px] text-[color:var(--color-text-primary)]">
      💡 {children}
    </p>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'neutral' | 'info' | 'purple' | 'amber' | 'sky' | 'success' | 'danger'
}) {
  const styles: Record<typeof tone, string> = {
    neutral:
      'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
    info: 'bg-[color:var(--color-accent)]/30 text-[color:var(--color-text-primary)]',
    purple: 'bg-purple-100 text-purple-800',
    amber: 'bg-amber-100 text-amber-800',
    sky: 'bg-sky-100 text-sky-800',
    success: 'bg-green-100 text-green-800',
    danger: 'bg-red-100 text-red-800',
  }
  return (
    <span className={['inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', styles[tone]].join(' ')}>
      {children}
    </span>
  )
}

function TryItRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2 pt-1">{children}</div>
}

function TryIt({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
    >
      {label} <ArrowRight className="h-3 w-3" />
    </Link>
  )
}
