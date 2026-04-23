'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'

type Props = {
  currentPage: number
  totalPages: number
}

/**
 * Bottom-of-rows sentinel that auto-advances to the next page when it
 * enters the viewport. Uses URL navigation (?page=N+1) so the
 * server-side query runs normally. `scroll: false` keeps the scroll
 * position stable so the new page renders under the user's finger.
 *
 * Resets its one-shot firedRef whenever currentPage changes, so the
 * next mount (after navigation) is ready to advance again.
 */
export function InfiniteScrollSentinel({ currentPage, totalPages }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const firedRef = useRef(false)
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  useEffect(() => {
    firedRef.current = false
  }, [currentPage])

  useEffect(() => {
    if (!ref.current) return
    if (currentPage >= totalPages) return

    const el = ref.current
    const io = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry || !entry.isIntersecting) return
        if (firedRef.current) return

        firedRef.current = true
        const params = new URLSearchParams(sp.toString())
        params.set('page', String(currentPage + 1))
        router.push(`${pathname}?${params.toString()}`, { scroll: false })
      },
      { threshold: 0.1, rootMargin: '0px 0px 120px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [currentPage, totalPages, router, pathname, sp])

  if (currentPage >= totalPages) return null

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="h-10 text-center text-[11px] text-[color:var(--color-text-secondary)]"
    >
      Loading more…
    </div>
  )
}
