export default function Loading() {
  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-3 h-6 w-40 animate-pulse rounded bg-[color:var(--color-bg-secondary)]" />
      <div className="mb-3 flex gap-4 border-b border-[color:var(--color-border)] pb-2">
        <div className="h-5 w-16 animate-pulse rounded bg-[color:var(--color-bg-secondary)]" />
        <div className="h-5 w-20 animate-pulse rounded bg-[color:var(--color-bg-secondary)]" />
      </div>
      <div className="mb-3 h-9 w-full max-w-sm animate-pulse rounded bg-[color:var(--color-bg-secondary)]" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded bg-[color:var(--color-bg-secondary)]"
          />
        ))}
      </div>
    </section>
  )
}
