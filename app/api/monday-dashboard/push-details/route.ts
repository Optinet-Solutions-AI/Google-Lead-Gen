import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseDateRange } from '@/app/(dashboard)/_lib/date-range'
import {
  loadMondayPushDetails,
  type MondayPushDetailFilters,
} from '@/app/(dashboard)/_lib/monday-push-queries'

/**
 * JSON list of "pushed to Monday" leads for the drill-down side sheet.
 * Same filter surface as the export route (range, country, pusher,
 * day). The sheet fetches this lazily when opened so the initial
 * dashboard render stays cheap.
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
  return NextResponse.json({ range, filters, rows })
}
