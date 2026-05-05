import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { AddRecipientForm } from './_components/add-recipient-form'
import { RecipientRow } from './_components/recipient-row'

export const dynamic = 'force-dynamic'

type Recipient = {
  id: number
  email: string
  name: string | null
  country_code: string | null
  is_active: boolean
  notes: string | null
  created_at: string
  created_by: string | null
}

export default async function AlertRecipientsPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/alerts')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  const [{ data: recipients }, { data: countries }] = await Promise.all([
    svc
      .from('lead_alert_recipients')
      .select('id, email, name, country_code, is_active, notes, created_at, created_by')
      .order('is_active', { ascending: false })
      .order('country_code', { ascending: true, nullsFirst: true })
      .order('email', { ascending: true }),
    svc
      .from('gologin_profiles')
      .select('country_code, country_name')
      .eq('is_active', true)
      .order('country_name', { ascending: true }),
  ])

  const rows = (recipients ?? []) as Recipient[]
  const countryOptions =
    (countries ?? []).map(c => ({
      code: c.country_code as string,
      name: c.country_name as string,
    }))

  const activeCount = rows.filter(r => r.is_active).length

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Alert Recipients
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          People who get notified by email when a lead is found.
          Recipients without a country get every alert; recipients with a
          country only get alerts for leads scraped from that country.
          Email sending itself ships in the next pass — this page just
          manages the list.
        </p>
      </header>

      <AddRecipientForm countries={countryOptions} />

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <span>Recipients · {rows.length}</span>
          <span className="font-normal normal-case tracking-normal">
            {activeCount} active · {rows.length - activeCount} paused
          </span>
        </header>
        <div className="divide-y divide-[color:var(--color-border)]">
          {rows.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
              No recipients yet. Add one above.
            </p>
          )}
          {rows.map(r => (
            <RecipientRow key={r.id} recipient={r} />
          ))}
        </div>
      </section>
    </div>
  )
}
