import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Shadow-user visibility context for the current request.
 *
 * Bidirectional isolation:
 *   - non-shadow viewer (default everyone) should NOT see rows that
 *     belong to a shadow account.
 *   - shadow viewer should NOT see rows that belong to anyone else,
 *     even other shadow accounts — each shadow is its own silo.
 *
 * The dashboard uses service-role clients everywhere, so this
 * isolation is application-layer only (RLS would be a nice
 * follow-up). Every list query that surfaces user-attributed data
 * must call applyShadowFilter or one of the table-specific helpers
 * below.
 */
export type ShadowContext = {
  /** Lowercased email of the current viewer; null when anonymous. */
  email: string | null
  /** True when the viewer's user_profiles.is_shadow = true. */
  isShadow: boolean
}

/** Resolves the current request's shadow context. Cheap — uses the
 *  same in-flight auth.getUser() + a single user_profiles lookup. */
export async function getShadowContext(): Promise<ShadowContext> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { email: null, isShadow: false }

  const svc = createServiceClient()
  const { data } = await svc.rpc('is_shadow_user', { p_user_id: user.id })
  return {
    email: (user.email ?? '').toLowerCase() || null,
    isShadow: data === true,
  }
}

/**
 * Apply the shadow-visibility filter to a Supabase query builder.
 *
 * Pass the column names that hold the row's owner email and shadow
 * flag respectively. Both default to the canonical scrape_queue /
 * google_lead_gen_table column names.
 *
 * Returns the chained query (call .select().eq() etc. before AND
 * after).
 */
export function applyShadowFilter<Q extends QueryWithFilters>(
  query: Q,
  ctx: ShadowContext,
  opts?: {
    /** Owner-email column on this table. Default: 'created_by_email'. */
    emailColumn?: string
    /** Shadow-flag column on this table. Default: 'created_by_is_shadow'. */
    shadowColumn?: string
  },
): Q {
  const emailColumn = opts?.emailColumn ?? 'created_by_email'
  const shadowColumn = opts?.shadowColumn ?? 'created_by_is_shadow'

  if (ctx.isShadow) {
    // Shadow viewer: only their own rows. The owner-email match is
    // case-insensitive on the application side via toLowerCase() at
    // context creation; Supabase's `eq` is case-sensitive but emails
    // are stored lowercase by the enqueue action so this is fine.
    if (!ctx.email) {
      // Defensive: no email → return a guaranteed-empty result rather
      // than leak everything. Use an impossible value.
      return query.eq(emailColumn, '__shadow_no_email__') as Q
    }
    return query.eq(emailColumn, ctx.email) as Q
  }

  // Non-shadow viewer: everything EXCEPT shadow-owned rows.
  // `eq` with false is what we want; the column default is false, so
  // existing rows from before the migration also pass.
  return query.eq(shadowColumn, false) as Q
}

/**
 * Minimal interface the helper needs from a Supabase query builder.
 * Using a structural type means we can apply the same helper to any
 * builder shape (.from(...).select(...), .rpc(...), etc.) without
 * importing Supabase's generic type machinery.
 */
type QueryWithFilters = {
  eq: (column: string, value: unknown) => unknown
}
