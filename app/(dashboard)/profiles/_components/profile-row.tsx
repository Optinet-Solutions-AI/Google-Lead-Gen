'use client'

import { useState, useTransition } from 'react'
import {
  setIsGoogleLoggedIn,
  setProfileNotes,
  setRequiresGoogleLogin,
} from '../actions'

export type ProfileRow = {
  country_code: string
  country_name: string
  gologin_display_name: string | null
  gologin_profile_id: string | null
  is_active: boolean
  requires_google_login: boolean
  is_google_logged_in: boolean
  google_login_verified_at: string | null
  google_login_notes: string | null
  login_check_source: string | null
  updated_at: string
}

export function ProfileRowEditor({ profile }: { profile: ProfileRow }) {
  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-b-0">
      <Td>
        <span className="font-medium text-[color:var(--color-text-primary)]">{profile.country_code}</span>
        <span className="ml-2 text-[color:var(--color-text-secondary)]">{profile.country_name}</span>
      </Td>
      <Td className="max-w-[280px] truncate text-[color:var(--color-text-secondary)]">
        {profile.gologin_display_name ?? '—'}
      </Td>
      <Td>
        <ToggleCell
          country={profile.country_code}
          value={profile.requires_google_login}
          action={setRequiresGoogleLogin}
        />
      </Td>
      <Td>
        <ToggleCell
          country={profile.country_code}
          value={profile.is_google_logged_in}
          action={setIsGoogleLoggedIn}
          color={profile.is_google_logged_in ? 'green' : profile.requires_google_login ? 'amber' : 'gray'}
        />
      </Td>
      <Td className="text-[color:var(--color-text-secondary)]">
        {profile.google_login_verified_at ? (
          <>
            <span className="text-[color:var(--color-text-primary)]">
              {new Date(profile.google_login_verified_at).toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {profile.login_check_source && (
              <span className="ml-1.5 text-[10px]">({profile.login_check_source})</span>
            )}
          </>
        ) : (
          '—'
        )}
      </Td>
      <Td className="min-w-[240px]">
        <NotesField country={profile.country_code} initial={profile.google_login_notes} />
      </Td>
    </tr>
  )
}

function ToggleCell({
  country,
  value,
  action,
  color = 'green',
}: {
  country: string
  value: boolean
  action: (fd: FormData) => void | Promise<void>
  color?: 'green' | 'amber' | 'gray'
}) {
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<'idle' | 'error'>('idle')
  function flip() {
    const fd = new FormData()
    fd.set('country_code', country)
    fd.set('value', value ? 'false' : 'true')
    startTransition(async () => {
      try {
        await action(fd)
        setSaved('idle')
      } catch {
        setSaved('error')
        setTimeout(() => setSaved('idle'), 2500)
      }
    })
  }
  const onCls =
    color === 'green'
      ? 'bg-emerald-100 text-emerald-800'
      : color === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-zinc-200 text-zinc-700'
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={flip}
        disabled={pending}
        className={[
          'inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
          value ? onCls : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
        ].join(' ')}
      >
        {value ? 'Yes' : 'No'}
      </button>
      {saved === 'error' && <span className="text-[10px] text-red-700">err</span>}
    </div>
  )
}

function NotesField({ country, initial }: { country: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? '')
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<'idle' | 'ok' | 'error'>('idle')

  function save() {
    if (value === (initial ?? '')) return
    const fd = new FormData()
    fd.set('country_code', country)
    fd.set('notes', value)
    startTransition(async () => {
      try {
        await setProfileNotes(fd)
        setSaved('ok')
        setTimeout(() => setSaved('idle'), 1500)
      } catch {
        setSaved('error')
        setTimeout(() => setSaved('idle'), 2500)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        placeholder="e.g. logged in as foo@gmail.com"
        disabled={pending}
        className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {saved === 'ok' && <span className="text-[10px] text-emerald-700">saved</span>}
      {saved === 'error' && <span className="text-[10px] text-red-700">err</span>}
    </div>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={['whitespace-nowrap px-3 py-2 align-middle text-[12px]', className ?? ''].join(' ')}>
      {children}
    </td>
  )
}
