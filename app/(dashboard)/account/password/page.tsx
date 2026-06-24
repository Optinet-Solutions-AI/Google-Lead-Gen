import { createClient } from '@/lib/supabase/server'
import { getUserPreferences } from '@/lib/user-preferences'
import { CaptchaReviewToggle } from './_components/captcha-review-toggle'
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

      <section className="flex flex-col gap-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header>
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Preferences
          </h2>
        </header>

        <div className="flex flex-col gap-2 border-t border-[color:var(--color-border)] pt-3">
          <div>
            <h3 className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">
              Auto-load on scroll
            </h3>
            <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
              When ON, scrolling past the last visible row on{' '}
              <code>/leads</code> and <code>/scrape</code> auto-loads the
              next page. When OFF (default), the <strong>Rows</strong>{' '}
              picker is a hard limit and you page through results with the
              chevrons or by typing a custom row count.
            </p>
          </div>
          <InfiniteScrollToggle enabled={prefs.infiniteScrollEnabled} />
        </div>

        <div className="flex flex-col gap-2 border-t border-[color:var(--color-border)] pt-3">
          <div>
            <h3 className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">
              Available for CAPTCHA review
            </h3>
            <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
              When ON, scrapes you queue that hit a CAPTCHA wall will park
              in <code>needs_human</code> and wait up to 65 minutes for
              you to click through on <code>/admin/interactive</code>.
              When OFF (default), the worker skips that wait — it either
              uses the 2Captcha auto-solver (when enabled in{' '}
              <code>/admin/system</code>) or fails the job fast — so your
              queue doesn&apos;t stall when you&apos;re not around to
              action it.
            </p>
          </div>
          <CaptchaReviewToggle enabled={prefs.availableForCaptchaReview} />
        </div>
      </section>
    </div>
  )
}
