import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin } from '@/lib/auth/require-admin'
import { reportBySlug } from '@/app/(dashboard)/admin/reports/_lib/reports'

export const dynamic = 'force-dynamic'

/**
 * Serves a measurement report's HTML to admins only.
 *
 * The files live in `/reports` rather than `/public` because they contain
 * affiliate domains, Rooster brand names and contact details, and anything
 * under `public/` is world-readable with no session. The slug is matched
 * against the report manifest, so no caller-supplied path ever reaches the
 * filesystem.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const admin = await requireAdmin()
  if (!admin.ok) {
    return new Response('Admin access required.', { status: 403, headers: { 'Content-Type': 'text/plain' } })
  }

  const { slug } = await ctx.params
  const report = reportBySlug(slug)
  if (!report) {
    return new Response('No such report.', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  }

  try {
    const html = await readFile(join(process.cwd(), 'reports', `${report.slug}.html`), 'utf8')
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        // Never let a shared cache or CDN hold an authenticated report.
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  } catch {
    return new Response('The report file is missing from this deployment.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
}
