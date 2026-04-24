'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

type Props = {
  /** When true, the component polls router.refresh() every `intervalMs`. */
  enabled: boolean
  intervalMs?: number
}

/**
 * Polls router.refresh() so Server Component data (the jobs table) re-fetches
 * without a full page reload. Only runs when there are pending/running jobs.
 */
export function AutoRefresh({ enabled, intervalMs = 5000 }: Props) {
  const router = useRouter()

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs, router])

  return null
}
