import { createClient } from '@/lib/supabase/server'
import { getUserPreferences } from '@/lib/user-preferences'
import { ChangePasswordForm } from './_components/change-password-form'
import { InfiniteScrollToggle } from './_components/infinite-scroll-toggle'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const supabase = await createClient()
  const [
    {
      data: { user },
    },
    prefs,
  ] = await Promise.all([supabase.auth.getUser(), getUserPreferences()])

  const emailLocalPart = user?.email?.split('@')[0] ?? 'user'

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          My account
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Signed in as <span className="text-[color:var(--color-text-primary)]">{emailLocalPart}</span>
        </p>
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Change password
          </h2>
        </header>
        <ChangePasswordForm />
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Preferences
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            When ON, scrolling past the last visible row on{' '}
            <code>/leads</code> and <code>/scrape</code> auto-loads the next
            page. When OFF (default), the <strong>Rows</strong> picker is a
            hard limit and you page through results with the chevrons or by
            typing a custom row count.
          </p>
        </header>
        <InfiniteScrollToggle enabled={prefs.infiniteScrollEnabled} />
      </section>
    </div>
  )
}
