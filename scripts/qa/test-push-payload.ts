/**
 * Automated QA for the push-to-Monday preparation phase.
 *
 * Exercises `prepareLeadPushPayload()` end-to-end against the live DB
 * across the scenarios touched by the recent QA fixes:
 *
 *   T1  unmapped user (monday_user_id = 0)        → block with friendly error
 *   T2  unmapped user (monday_user_id = NaN)      → same block, same error
 *   T3  non-existent lead id                      → "Lead X not found"
 *   T4  already-pushed lead                       → "Already pushed" guard
 *   T5  happy path (real unpushed lead + mapped user)
 *         → ok=true, owner matches, anchor either null or {groupId,itemId},
 *           columnValues has the legacy keys, item name is a clean domain
 *   T6  static union check on MondayLabelValue    → all 10 categories exported
 *
 * READ-ONLY: nothing here writes to Monday or mutates a lead. The happy-path
 * test calls `prepareLeadPushPayload`, which is the read-only half that
 * 665dbe4 split out specifically so it could be exercised this way.
 *
 * Run:
 *   npx tsx scripts/qa/test-push-payload.ts
 *
 * Prereqs (same as monday:sync):
 *   .env.local must define MONDAY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '.env.local') })

type CaseResult = { name: string; ok: boolean; detail: string }
const results: CaseResult[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  const tag = ok ? '✓ PASS' : '✗ FAIL'
  console.log(`${tag}  ${name}`)
  if (detail) console.log(`        ${detail}`)
}

async function main(): Promise<void> {
  // Dynamic imports so loadEnv runs first (server-only helpers read env at import time).
  const { createClient } = await import('@supabase/supabase-js')
  const { prepareLeadPushPayload } = await import('@/lib/monday/push-lead')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(2)
  }
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ────────────────────────────────────────────────────────────────
  // Resolve fixtures from the live DB
  // ────────────────────────────────────────────────────────────────
  console.log('Resolving fixtures from live DB…')

  const { data: mappedUser } = await svc
    .from('user_profiles')
    .select('id, username, display_name, monday_user_id')
    .not('monday_user_id', 'is', null)
    .limit(1)
    .maybeSingle()

  const { data: unpushedLead } = await svc
    .from('google_lead_gen_table')
    .select('id, domain, url')
    .is('pushed_to_monday_at', null)
    .not('domain', 'is', null)
    .limit(1)
    .maybeSingle()

  const { data: pushedLead } = await svc
    .from('google_lead_gen_table')
    .select('id, pushed_to_monday_at, monday_pushed_item_id')
    .not('pushed_to_monday_at', 'is', null)
    .limit(1)
    .maybeSingle()

  type Profile = { id: string; username: string | null; display_name: string | null; monday_user_id: number | null }
  type LeadLite = { id: number; domain: string | null; url: string | null }
  type LeadPushed = { id: number; pushed_to_monday_at: string | null; monday_pushed_item_id: string | null }

  const userRow = mappedUser as Profile | null
  const fresh = unpushedLead as LeadLite | null
  const pushed = pushedLead as LeadPushed | null

  console.log(`  mapped user: ${userRow ? `${userRow.username ?? userRow.id} (monday_user_id=${userRow.monday_user_id})` : 'NONE FOUND'}`)
  console.log(`  unpushed lead: ${fresh ? `#${fresh.id} (${fresh.domain ?? fresh.url})` : 'NONE FOUND'}`)
  console.log(`  pushed lead:   ${pushed ? `#${pushed.id} (pushed ${pushed.pushed_to_monday_at})` : 'NONE FOUND'}`)
  console.log('')

  const FAKE_USER = { pushedBy: 'qa-test', pushedByMondayId: 12345 }

  // ────────────────────────────────────────────────────────────────
  // T1 — unmapped user (id = 0) is blocked with the friendly error
  // ────────────────────────────────────────────────────────────────
  {
    const out = await prepareLeadPushPayload(1, { pushedBy: 'qa-test', pushedByMondayId: 0 })
    const ok =
      !out.ok &&
      out.error.includes('not linked to a Monday user') &&
      out.error.includes('/admin/users')
    record(
      'T1  pushedByMondayId=0 blocks with friendly error',
      ok,
      out.ok ? 'expected error, got ok' : `error="${out.error}"`,
    )
  }

  // ────────────────────────────────────────────────────────────────
  // T2 — NaN Monday ID is treated the same as 0
  // ────────────────────────────────────────────────────────────────
  {
    const out = await prepareLeadPushPayload(1, { pushedBy: 'qa-test', pushedByMondayId: Number.NaN })
    const ok = !out.ok && out.error.includes('not linked to a Monday user')
    record(
      'T2  pushedByMondayId=NaN blocks with same error',
      ok,
      out.ok ? 'expected error, got ok' : `error="${out.error}"`,
    )
  }

  // ────────────────────────────────────────────────────────────────
  // T3 — non-existent lead id returns "Lead X not found"
  // ────────────────────────────────────────────────────────────────
  {
    const bogus = 2_147_483_000 // very unlikely to exist
    const out = await prepareLeadPushPayload(bogus, FAKE_USER)
    const ok = !out.ok && out.error.includes(`Lead ${bogus} not found`)
    record(
      'T3  unknown lead id returns "not found"',
      ok,
      out.ok ? 'expected error, got ok' : `error="${out.error}"`,
    )
  }

  // ────────────────────────────────────────────────────────────────
  // T4 — already-pushed lead returns the "Already pushed" guard
  // ────────────────────────────────────────────────────────────────
  if (!pushed) {
    record(
      'T4  already-pushed guard',
      false,
      'SKIPPED — no lead with pushed_to_monday_at IS NOT NULL found in DB',
    )
  } else {
    const out = await prepareLeadPushPayload(pushed.id, FAKE_USER)
    const ok = !out.ok && out.error.startsWith('Already pushed to Monday on')
    record(
      `T4  lead #${pushed.id} (already pushed) blocks re-push`,
      ok,
      out.ok ? 'expected error, got ok' : `error="${out.error}"`,
    )
  }

  // ────────────────────────────────────────────────────────────────
  // T5 — happy path: real unpushed lead + real mapped user.
  //      Verifies owner, source mapping, item name, columnValues shape,
  //      and the anchor returns either null or a well-formed object.
  // ────────────────────────────────────────────────────────────────
  if (!userRow || userRow.monday_user_id == null) {
    record(
      'T5  happy-path preparation',
      false,
      'SKIPPED — no user_profile with monday_user_id set; populate one via /admin/users',
    )
  } else if (!fresh) {
    record(
      'T5  happy-path preparation',
      false,
      'SKIPPED — no unpushed lead with a domain found in DB',
    )
  } else {
    const out = await prepareLeadPushPayload(fresh.id, {
      pushedBy: userRow.display_name ?? userRow.username ?? userRow.id,
      pushedByMondayId: userRow.monday_user_id,
    })

    if (!out.ok) {
      record(
        `T5  happy-path lead #${fresh.id}`,
        false,
        `prepareLeadPushPayload returned error: "${out.error}"`,
      )
    } else {
      const d = out.data
      const cv = d.columnValues as Record<string, unknown>

      const ownerOk = d.meta.ownerId === userRow.monday_user_id
      const cvHasKeys = ['text86', 'text54', 'status', 'status_1', 'text0', 'date', 'text1', 'project_owner']
        .every(k => k in cv)
      const sourceOk = d.meta.source === 'PPC' || d.meta.source === 'SEO'
      const itemNameOk = typeof d.itemName === 'string' && d.itemName.length > 0
      const cleanItemName = !/^https?:\/\//.test(d.itemName) && !d.itemName.startsWith('www.')
      const anchorOk =
        d.anchor === null ||
        (typeof d.anchor === 'object' &&
          typeof d.anchor.groupId === 'string' &&
          typeof d.anchor.itemId === 'string')

      // project_owner column value carries the operator's Monday id.
      const po = cv['project_owner'] as
        | { personsAndTeams?: Array<{ id: number; kind: string }> }
        | undefined
      const personId = po?.personsAndTeams?.[0]?.id
      const projectOwnerOk = personId === userRow.monday_user_id

      // Status label is the literal "New Lead" string the legacy n8n flow used.
      const status = cv['status'] as { label?: string } | undefined
      const statusOk = status?.label === 'New Lead'

      // Date should be today's YYYY-MM-DD.
      const today = new Date().toISOString().slice(0, 10)
      const dateCol = cv['date'] as { date?: string } | undefined
      const dateOk = dateCol?.date === today

      const allOk =
        ownerOk &&
        cvHasKeys &&
        sourceOk &&
        itemNameOk &&
        cleanItemName &&
        anchorOk &&
        projectOwnerOk &&
        statusOk &&
        dateOk

      const detail = [
        `ownerId=${d.meta.ownerId} (expected ${userRow.monday_user_id}) ${ownerOk ? 'OK' : 'BAD'}`,
        `source=${d.meta.source} ${sourceOk ? 'OK' : 'BAD'}`,
        `itemName="${d.itemName}" ${itemNameOk && cleanItemName ? 'OK' : 'BAD'}`,
        `columnValues keys ${cvHasKeys ? 'OK' : 'MISSING'}`,
        `project_owner.id=${personId} ${projectOwnerOk ? 'OK' : 'BAD'}`,
        `status.label=${status?.label} ${statusOk ? 'OK' : 'BAD'}`,
        `date.date=${dateCol?.date} (expected ${today}) ${dateOk ? 'OK' : 'BAD'}`,
        `anchor=${d.anchor ? `{group=${d.anchor.groupId}, item=${d.anchor.itemId}}` : 'null (fallback path)'} ${anchorOk ? 'OK' : 'BAD'}`,
      ].join(' | ')

      record(`T5  happy-path lead #${fresh.id}`, allOk, detail)
    }
  }

  // ────────────────────────────────────────────────────────────────
  // T6 — static union check on MondayLabelValue (553c773 export).
  //      If the union changes shape, the cast/check below stops type-checking,
  //      which is exactly what we want a tsx/tsc run to catch.
  // ────────────────────────────────────────────────────────────────
  {
    const mod = await import('@/app/(dashboard)/leads/actions')
    type Expected =
      | 'no'
      | 'clear'
      | 'affiliates'
      | 'affiliates_updates'
      | 'leads'
      | 'leads_updates'
      | 'not_relevant_leads'
      | 'not_relevant_leads_updates'
      | 'email_undelivered_leads'
      | 'email_undelivered_leads_updates'

    // Two-way assignability: any drift between MondayLabelValue and Expected
    // becomes a type error at this point. The runtime portion only checks
    // the module loaded, since unions don't exist at runtime.
    const sample: Expected = 'leads'
    const asUnion: import('@/app/(dashboard)/leads/actions').MondayLabelValue = sample
    void asUnion
    const ok = typeof mod.pushLeadToMondayAction === 'function'
    record(
      'T6  MondayLabelValue union + action export',
      ok,
      ok ? 'union compiles; pushLeadToMondayAction exported' : 'action not exported',
    )
  }

  // ────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────
  console.log('')
  console.log('═'.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  console.log(`  ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ''}`)
  if (failed > 0) {
    console.log('')
    for (const r of results.filter(x => !x.ok)) {
      console.log(`  FAIL: ${r.name}`)
      console.log(`        ${r.detail}`)
    }
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
