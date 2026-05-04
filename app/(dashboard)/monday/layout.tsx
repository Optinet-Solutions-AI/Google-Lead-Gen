// The manual "Sync from Monday" server action runs a full re-sync of
// all 4 boards which can take 3-5 minutes. Server actions inherit the
// max execution time of their hosting segment, so bump the limit here
// to match /api/monday/sync (Vercel Pro caps this at 300s).
export const maxDuration = 300

export default function MondayLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="min-w-0 px-4 py-4 md:px-6 md:py-6">{children}</div>
  )
}
