export default function MondayLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="min-w-0 px-4 py-4 md:px-6 md:py-6">{children}</div>
  )
}
