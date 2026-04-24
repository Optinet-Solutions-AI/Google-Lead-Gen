/**
 * Plain HTTP fetcher with browser-ish headers + timeout.
 *
 * For first iteration. Many casino-affiliate sites are behind
 * Cloudflare and will return 403/503 to us — those rows simply
 * get classified with confidence ERROR and the user can retry
 * or override manually. A future iteration can swap this for a
 * VM-side fetch through a residential proxy.
 */

const DEFAULT_TIMEOUT_MS = 8_000

const BROWSER_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
}

export type FetchResult =
  | { ok: true; html: string; finalUrl: string; status: number }
  | { ok: false; error: string; status: number | null }

export async function fetchHtml(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status }
    }
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
      return { ok: false, error: `Non-HTML content-type: ${ctype}`, status: res.status }
    }
    const html = await res.text()
    return { ok: true, html, finalUrl: res.url, status: res.status }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg, status: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run a list of async tasks with a max concurrency cap.
 * Returns results in input order; never throws (per-task errors stay in results).
 */
export async function runWithConcurrency<T, R>(
  inputs: T[],
  concurrency: number,
  worker: (input: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length)
  let cursor = 0
  async function consume() {
    while (true) {
      const i = cursor++
      if (i >= inputs.length) return
      results[i] = await worker(inputs[i] as T, i)
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, inputs.length) }, () => consume())
  await Promise.all(runners)
  return results
}
