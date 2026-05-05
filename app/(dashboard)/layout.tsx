import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { DashboardShell } from './_components/dashboard-shell'

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Middleware guarantees the user is signed in before reaching here.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Show the local-part of the email as the username (e.g. "admin" for
  // admin@rooster.local). Keeps the sidebar concise.
  const username = user?.email?.split('@')[0] ?? 'user'

  // Check admin status so the sidebar can conditionally show the
  // /admin/users link. The page itself also re-checks server-side so
  // the conditional nav is purely a UX nicety, not a security gate.
  let isAdmin = false
  if (user?.id) {
    const svc = createServiceClient()
    const { data } = await svc.rpc('is_admin', { p_user_id: user.id })
    isAdmin = data === true
  }

  return (
    <DashboardShell username={username} isAdmin={isAdmin}>
      {children}
    </DashboardShell>
  )
}
