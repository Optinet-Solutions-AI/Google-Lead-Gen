import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export type GoLoginProfile = {
  country_code: string
  country_name: string
}

export async function listActiveProfiles(): Promise<GoLoginProfile[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_name', { ascending: true })
  if (error) throw error
  return (data ?? []) as GoLoginProfile[]
}

export type ScrapeJob = {
  id: string
  keyword: string
  country_code: string
  pages: number
  priority: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha'
  attempts: number
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  batch_id: number | null
  created_at: string
}

export async function listRecentJobs(limit = 30): Promise<ScrapeJob[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, pages, priority, status, attempts, claimed_by, started_at, completed_at, error_message, result_summary, batch_id, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as ScrapeJob[]
}
