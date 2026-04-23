import { TableNav } from './_components/table-nav'

export default function MondayLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:flex-row md:px-6 md:py-6">
      <div className="min-w-0 flex-1">{children}</div>
      <TableNav />
    </div>
  )
}
