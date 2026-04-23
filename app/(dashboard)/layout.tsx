import { createClient } from '@/lib/supabase/server'
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

  return <DashboardShell username={username}>{children}</DashboardShell>
}
