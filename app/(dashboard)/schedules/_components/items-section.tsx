'use client'

import { useActionState } from 'react'
import { Trash2, Power } from 'lucide-react'
import {
  addScheduledItem,
  deleteScheduledItem,
  toggleScheduledItem,
  type ActionState,
} from '../actions'
import type { ScheduledItem } from '../_lib/queries'

const initial: ActionState = null

type Props = {
  setId: string
  items: ScheduledItem[]
  countries: Array<{ code: string; name: string }>
}

export function ItemsSection({ setId, items, countries }: Props) {
  const [state, formAction, pending] = useActionState(addScheduledItem, initial)

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
        Keywords in this set ({items.length})
      </h2>

      {/* Add form */}
      <form
        action={formAction}
        className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3"
      >
        <input type="hidden" name="set_id" value={setId} />
        <div className="grid gap-2 md:grid-cols-[1fr_140px_80px_80px_auto] md:items-end">
          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
            Keyword
            <input
              name="keyword"
              type="text"
              required
              maxLength={500}
              placeholder='e.g. "best online casinos 2026"'
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
            Country
            <select
              name="country_code"
              required
              defaultValue=""
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
            >
              <option value="" disabled>
                Pick…
              </option>
              {countries.map(c => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
            Pages
            <input
              name="pages"
              type="number"
              min={1}
              max={10}
              placeholder="inherit"
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
            Priority
            <input
              name="priority"
              type="number"
              min={0}
              max={100}
              defaultValue={0}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px]"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="h-[34px] shrink-0 rounded-md bg-[color:var(--color-accent)] px-4 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
          >
            {pending ? 'Adding…' : 'Add'}
          </button>
        </div>

        {state?.status === 'ok' && (
          <p className="mt-2 text-[11px] text-green-700">{state.message}</p>
        )}
        {state?.status === 'error' && (
          <p className="mt-2 text-[11px] text-red-700">{state.error}</p>
        )}
      </form>

      {/* List */}
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-8 text-center text-[12px] text-[color:var(--color-text-secondary)]">
          No keywords yet. Add one above and the scheduler will enqueue it on every tick.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-[color:var(--color-bg-secondary)]">
              <tr>
                <Th>Keyword</Th>
                <Th>Country</Th>
                <Th>Pages</Th>
                <Th>Priority</Th>
                <Th>Active</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr
                  key={it.id}
                  className="border-b border-[color:var(--color-border)] last:border-b-0"
                >
                  <Td className="max-w-[380px] truncate" title={it.keyword}>
                    {it.keyword}
                  </Td>
                  <Td>{it.country_code}</Td>
                  <Td className="text-[color:var(--color-text-secondary)]">
                    {it.pages ?? 'inherit'}
                  </Td>
                  <Td>{it.priority}</Td>
                  <Td>
                    <form action={toggleScheduledItem}>
                      <input type="hidden" name="item_id" value={it.id} />
                      <input type="hidden" name="set_id" value={setId} />
                      <button
                        type="submit"
                        title={it.is_active ? 'Disable' : 'Enable'}
                        className={[
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                          it.is_active
                            ? 'bg-green-100 text-green-800 hover:bg-green-200'
                            : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-border)]',
                        ].join(' ')}
                      >
                        <Power className="h-3 w-3" />
                        {it.is_active ? 'on' : 'off'}
                      </button>
                    </form>
                  </Td>
                  <Td>
                    <form action={deleteScheduledItem}>
                      <input type="hidden" name="item_id" value={it.id} />
                      <input type="hidden" name="set_id" value={setId} />
                      <button
                        type="submit"
                        title="Remove"
                        className="text-red-700 hover:text-red-900"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap border-b border-[color:var(--color-border)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]"
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <td
      {...(title ? { title } : {})}
      className={['whitespace-nowrap px-3 py-2 align-middle', className ?? ''].join(' ')}
    >
      {children}
    </td>
  )
}
