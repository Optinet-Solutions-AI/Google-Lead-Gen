import { createServiceClient } from '@/lib/supabase/service'
import { AddBrandForm } from './_components/add-brand-form'
import { BrandRowEditor, type BrandRow } from './_components/brand-row'

export const dynamic = 'force-dynamic'

export default async function BrandsPage() {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('rooster_brands')
    .select('id, domain, brand_name, notes, is_active, updated_at')
    .order('brand_name', { ascending: true, nullsFirst: false })
    .order('domain', { ascending: true })
  if (error) throw error
  const brands = (data ?? []) as BrandRow[]

  const total = brands.length
  const active = brands.filter(b => b.is_active).length

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Rooster brands
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Domains the Rooster partner check considers &quot;ours&quot;. When a scraped lead links
          out to any of these (active) domains, the lead is flagged as a Rooster partner.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <Badge label={`${total} brands`} cls="bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]" />
          <Badge label={`${active} active`} cls="bg-emerald-100 text-emerald-800" />
          {total - active > 0 && (
            <Badge label={`${total - active} disabled`} cls="bg-zinc-200 text-zinc-700" />
          )}
        </div>
      </header>

      <AddBrandForm />

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-[color:var(--color-border-strong)]">
            <tr>
              <Th>Domain</Th>
              <Th>Brand name</Th>
              <Th>Active?</Th>
              <Th>Notes</Th>
              <Th>{''}</Th>
            </tr>
          </thead>
          <tbody>
            {brands.map(b => <BrandRowEditor key={b.id} brand={b} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={['inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium', cls].join(' ')}>
      {label}
    </span>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="sticky top-0 z-20 whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]"
    >
      {children}
    </th>
  )
}
