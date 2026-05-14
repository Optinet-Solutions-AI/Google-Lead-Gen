'use client'

import type { LeadDetail } from './detail-query'

// Module-scoped in-memory cache for the lead detail drawer. Keeps
// re-opening the same lead instant (SWR pattern: serve cached, refresh
// in background). Any code that mutates lead data should call
// invalidateLeadDetailCache(id) so the next open does a fresh fetch.
const cache = new Map<number, LeadDetail>()

export function getCachedLeadDetail(leadId: number): LeadDetail | undefined {
  return cache.get(leadId)
}

export function setCachedLeadDetail(leadId: number, detail: LeadDetail): void {
  cache.set(leadId, detail)
}

export function invalidateLeadDetailCache(leadId: number): void {
  cache.delete(leadId)
}
