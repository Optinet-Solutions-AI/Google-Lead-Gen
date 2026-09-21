'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { CalendarDays, CalendarRange, Check, ChevronDown, User, Users } from 'lucide-react'

/**
 * The always-on filters for /scrape: which day, and whose work.
 *
 * These two are how the list is read every day, so they sit in the bar
 * rather than behind "+ Add filter" — that stays for the occasional extra
 * condition. Defaults are today + mine, which is what an operator wants on
 * open; both widen from here.
 *
 * URL-driven so a view is shareable and the back button behaves:
 *   ?day=YYYY-MM-DD | all   (absent = today)
 *   ?owner=mine | all | <email>   (absent = mine)
 */

export type ScopeUser = { email: string; label: string }

type Props = {
  /** Today as a UTC day string, resolved on the server so the chip does not
   *  depend on the viewer's clock. */
  today: string
  day: string | 'all'
  owner: string
  /** The signed-in user's email, so "Mine" can be labelled and matched. */
  meEmail: string | null
  users: ScopeUser[]
}

export function ScopeBar({ today, day, owner, meEmail, users }: Props) {
  const router = useRouter()
  const sp = useSearchParams()

  const push = (mutate: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(sp.toString())
    mutate(params)
    params.delete('page')
    const qs = params.toString()
    router.push(qs ? `/scrape?${qs}` : '/scrape', { scroll: false })
  }

  const setDay = (next: string | 'all') =>
    push(p => { if (next === today) p.delete('day'); else p.set('day', next) })

  const setOwner = (next: string) =>
    push(p => { if (next === 'mine') p.delete('owner'); else p.set('owner', next) })

  const isToday = day === today
  const ownerIsMine = owner === 'mine'
  const ownerIsAll = owner === 'all'
  const pickedUser = !ownerIsMine && !ownerIsAll ? users.find(u => u.email === owner) ?? null : null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* ---- day ---- */}
      <div role="group" aria-label="Day" className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <Segment
          active={isToday}
          onClick={() => setDay(today)}
          label="Today"
          title="Only scrapes queued today (UTC)"
        >
          <CalendarDays className="h-3.5 w-3.5" />
        </Segment>
        <Divider />
        <Segment
          active={day === 'all'}
          onClick={() => setDay('all')}
          label="All dates"
          title="Every scrape, any date"
        >
          <CalendarRange className="h-3.5 w-3.5" />
        </Segment>
      </div>

      {/* a specific past day, chosen from the picker */}
      <DayPicker current={isToday || day === 'all' ? '' : day} onPick={d => setDay(d)} max={today} />

      {/* ---- owner ---- */}
      <div role="group" aria-label="Owner" className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <Segment
          active={ownerIsMine}
          onClick={() => setOwner('mine')}
          label="Mine"
          title={meEmail ? `Only my scrapes (${meEmail})` : 'Only my scrapes'}
        >
          <User className="h-3.5 w-3.5" />
        </Segment>
        <Divider />
        <Segment
          active={ownerIsAll}
          onClick={() => setOwner('all')}
          label="Everyone"
          title="Scrapes queued by anyone"
        >
          <Users className="h-3.5 w-3.5" />
        </Segment>
      </div>

      <UserPicker
        users={users}
        picked={pickedUser}
        onPick={email => setOwner(email)}
        onClear={() => setOwner('mine')}
      />
    </div>
  )
}

function Segment({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={title}
      className={[
        'inline-flex items-center justify-center px-2.5 py-1.5 transition-colors',
        active
          ? 'bg-[color:var(--color-accent)]/20 text-[color:var(--color-text-primary)]'
          : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="w-px bg-[color:var(--color-border)]" aria-hidden="true" />

/** A plain date input. Picking a day switches the list to it; the Today and
 *  All-dates chips clear it. */
function DayPicker({ current, onPick, max }: { current: string; onPick: (d: string) => void; max: string }) {
  return (
    <label
      title="Show a specific day"
      className={[
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]',
        current
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)]',
      ].join(' ')}
    >
      <CalendarDays className="h-3.5 w-3.5 shrink-0" />
      <input
        type="date"
        value={current}
        max={max}
        onChange={e => { if (e.target.value) onPick(e.target.value) }}
        aria-label="Pick a day"
        className="w-[7.5rem] bg-transparent text-[12px] text-[color:var(--color-text-primary)] focus:outline-none"
      />
    </label>
  )
}

/** Whose batches to show. Kept in the bar because "what did X run" is a
 *  daily question, not an advanced one. */
function UserPicker({
  users,
  picked,
  onPick,
  onClear,
}: {
  users: ScopeUser[]
  picked: ScopeUser | null
  onPick: (email: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (users.length === 0) return null
  const shown = q ? users.filter(u => u.label.toLowerCase().includes(q.toLowerCase())) : users

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Show another person's batches"
        className={[
          'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px]',
          picked
            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
            : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
        ].join(' ')}
      >
        <User className="h-3.5 w-3.5" />
        <span className="max-w-[9rem] truncate">{picked ? picked.label : 'Someone else'}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        // Right-anchored and width-capped so it never runs off a phone.
        <div className="absolute right-0 top-full z-40 mt-1 w-[min(15rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] shadow-xl">
          <div className="border-b border-[color:var(--color-border)] p-2">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Find a person…"
              className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:outline-none"
            />
          </div>
          <ul className="max-h-60 overflow-y-auto py-1">
            {picked && (
              <li>
                <button
                  type="button"
                  onClick={() => { onClear(); setOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
                >
                  Clear — back to mine
                </button>
              </li>
            )}
            {shown.map(u => (
              <li key={u.email}>
                <button
                  type="button"
                  onClick={() => { onPick(u.email); setOpen(false) }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
                >
                  <span className="truncate">{u.label}</span>
                  {picked?.email === u.email && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-[color:var(--color-text-secondary)]">No match.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
