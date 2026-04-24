import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { loadLeadDetail } from '@/app/(dashboard)/leads/_lib/detail-query'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const leadId = Number.parseInt(id, 10)
  if (!Number.isFinite(leadId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  try {
    const detail = await loadLeadDetail(leadId)
    return NextResponse.json(detail, {
      headers: {
        // Fresh per request but allow the browser to reuse within the tab
        'Cache-Control': 'private, no-cache, must-revalidate',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
