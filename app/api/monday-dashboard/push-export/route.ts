import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseDateRange } from '@/app/(dashboard)/_lib/date-range'
import {
  loadMondayPushDetails,
  type MondayPushDetailFilters,
} from '@/app/(dashboard)/_lib/monday-push-queries'

/**
 * CSV export for the "Pushed to Monday" panel. Same query surface as
 * the side sheet — accepts range, country, pusher, day — but streams
 * the result as text/csv with a Content-Disposition attachment so the
 * browser opens the file-save dialog.
 *
 * Auth: uses the anon-key client so cookie-based session applies; the
 * dashboard is behind /(dashboard)/layout.tsx's auth gate, so callers
 * from the app are already signed in. Hitting the URL unauthenticated
 * returns 401.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const range = parseDateRange(sp.get('range') ?? undefined)
  const filters: MondayPushDetailFilters = {}
  const c = sp.get('country')
  if (c) filters.country = c
  const p = sp.get('pusher')
  if (p) filters.pusher = p
  const d = sp.get('day')
  if (d) filters.day = d
  if (sp.get('all') === '1') filters.all = true

  const rows = await loadMondayPushDetails(range, filters)

  const csv = toCsv(rows)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const windowBit = filters.all ? 'all-time' : range.key
  const filenameBits = ['monday-pushes', windowBit, filters.country, filters.pusher, filters.day, stamp]
    .filter(Boolean)
    .join('_')
    .replace(/[^\w.-]+/g, '-')
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameBits}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

const CSV_COLUMNS: Array<[string, (r: Awaited<ReturnType<typeof loadMondayPushDetails>>[number]) => unknown]> = [
  ['lead_id', r => r.lead_id],
  ['url', r => r.url],
  ['domain', r => r.domain],
  ['keyword', r => r.keyword],
  ['country_code', r => r.country_code],
  ['brand', r => r.brand],
  ['result_type', r => r.result_type],
  ['scraped_at', r => r.scraped_at],
  ['scraped_by', r => r.scraped_by],
  ['pushed_at', r => r.pushed_at],
  ['pushed_by', r => r.pushed_by],
  ['monday_pushed_item_id', r => r.monday_pushed_item_id],
]

function toCsv(rows: Awaited<ReturnType<typeof loadMondayPushDetails>>): string {
  const header = CSV_COLUMNS.map(([name]) => name).join(',')
  if (rows.length === 0) return header + '\n'
  const lines = [header]
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map(([, fn]) => csvCell(fn(r))).join(','))
  }
  return lines.join('\n') + '\n'
}

/**
 * RFC-4180-ish quoting: wrap in double-quotes iff the cell contains
 * a comma, quote, newline, or leading/trailing whitespace. Escape
 * inner quotes by doubling. null/undefined → empty string.
 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : String(v)
  if (!/[",\r\n]/.test(s) && s.trim() === s) return s
  return '"' + s.replace(/"/g, '""') + '"'
}
