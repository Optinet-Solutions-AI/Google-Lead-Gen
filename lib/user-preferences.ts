import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Per-user preferences that survive across sessions. Stored on
 * user_profiles alongside is_admin / is_shadow, so one read per
 * request is enough.
 *
 * Defaults (used when the user has no profile row, e.g. legacy
 * accounts that predate a preference column):
 *   - infiniteScrollEnabled: false → the Rows picker is a hard
 *     limit; no auto-load on scroll.
 *   - availableForCaptchaReview: false → scrapes from this user
 *     skip the needs_human wait and fall back to 2Captcha or fail
 *     fast on CAPTCHA hits.
 */
export type UserPreferences = {
  infiniteScrollEnabled: boolean
  availableForCaptchaReview: boolean
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  infiniteScrollEnabled: false,
  availableForCaptchaReview: false,
}

/**
 * Read the current viewer's preferences. Falls back to defaults
 * when anonymous or when no profile row exists.
 */
export async function getUserPreferences(): Promise<UserPreferences> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return DEFAULT_PREFERENCES

  const svc = createServiceClient()
  const { data } = await svc
    .from('user_profiles')
    .select('infinite_scroll_enabled, available_for_captcha_review')
    .eq('id', user.id)
    .maybeSingle()

  if (!data) return DEFAULT_PREFERENCES
  const row = data as {
    infinite_scroll_enabled: boolean | null
    available_for_captcha_review: boolean | null
  }
  return {
    infiniteScrollEnabled: row.infinite_scroll_enabled === true,
    availableForCaptchaReview: row.available_for_captcha_review === true,
  }
}
