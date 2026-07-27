import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { data } = await s
    .from('interactive_checkpoints')
    .select('id, worker_id, worker_port, vnc_host, status, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  const rows = (data ?? []) as Array<{
    id: number
    worker_id: string | null
    worker_port: number
    vnc_host: string | null
    status: string
    reason: string | null
    created_at: string
  }>
  console.log(`Recent checkpoints: ${rows.length}`)

  const portCounts: Record<string, number> = {}
  const portByStatus: Record<string, Record<string, number>> = {}
  const hostSet = new Set<string>()
  for (const r of rows) {
    const p = String(r.worker_port)
    portCounts[p] = (portCounts[p] ?? 0) + 1
    portByStatus[p] ??= {}
    portByStatus[p][r.status] = (portByStatus[p][r.status] ?? 0) + 1
    hostSet.add(r.vnc_host ?? '(null → falls back to NEXT_PUBLIC_VNC_BASE_URL)')
  }

  console.log(`\n=== worker_port distribution (nginx runbook only serves 9222-9224) ===`)
  for (const [p, n] of Object.entries(portCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const inRange = Number(p) >= 9222 && Number(p) <= 9224
    const byStat = Object.entries(portByStatus[p]!).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`  port ${p}  ×${n}  ${inRange ? 'OK (served)' : '⚠ NOT in nginx 922[2-4] → 404'}   [${byStat}]`)
  }

  console.log(`\n=== vnc_host values seen ===`)
  for (const h of hostSet) console.log(`  ${h}`)

  // waiting-now checkpoints specifically
  const waiting = rows.filter(r => r.status === 'waiting')
  console.log(`\n=== currently waiting (${waiting.length}) ===`)
  for (const r of waiting.slice(0, 20)) {
    const inRange = r.worker_port >= 9222 && r.worker_port <= 9224
    console.log(`  #${r.id}  ${r.worker_id ?? '-'}  port=${r.worker_port} ${inRange ? '' : '⚠404'}  host=${r.vnc_host ?? 'null'}  ${r.reason}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
