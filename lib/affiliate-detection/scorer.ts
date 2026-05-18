/**
 * Casino Affiliate Site classifier.
 *
 * VERBATIM port of the legacy n8n "Casino Affiliate Detector Code"
 * (see docs/_extracted_affiliate_scorer.js). Do NOT change scoring
 * weights or rule order without comparing precision/recall against
 * the legacy output — these heuristics encode years of domain
 * knowledge.
 *
 * Inputs: rendered HTML + the original URL.
 * Output: classification + confidence + the diagnostic indicators.
 */

export type AffiliateClassification = 'AFFILIATE' | 'NOT_AFFILIATE'
export type AffiliateConfidence = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'ERROR'

export type AffiliateScoreResult = {
  classification: AffiliateClassification
  confidence: AffiliateConfidence
  affiliateScore: number
  casinoScore: number
  scoreDifference: number
  externalCasinoLinks: number
  indicators: string[]
  error?: string
}

const CASINO_KEYWORDS = ['casino', 'bet', 'gaming', 'slots', 'poker', 'blackjack', 'spin']

const TRACKING_LINK_PATH_RE = /\/(track|click|go|visit|out|redirect|creat|aff|ref|link|offer|bonus|promo)\//i
const TRACKING_LINK_QUERY_RE = /[?&](ref|aff|affiliate|campaign|source|tracking|click)=/i
const HREF_RE = /href=["']([^"']+)["']/gi

const AFFILIATE_DISCLOSURES = [
  'we may earn',
  'earn commission',
  'affiliate commission',
  'compensated for referring',
  'advertising disclosure',
  'affiliate disclaimer',
]

const REVIEW_KEYWORDS = [
  'best online casino',
  'top casino',
  'casino review',
  'compare casino',
  'casino ranking',
  'casino comparison',
  'casino list',
  'recommended casino',
  'top 10',
  'top 25',
  'top 20',
]

const CTA_PATTERNS = [
  'visit casino',
  'visit site',
  'go to casino',
  'claim at',
  'play at',
  'get bonus',
  'claim bonus',
]

const BONUS_COMPARISON_KEYWORDS = [
  'welcome bonus',
  'bonus offer',
  'free spins',
  'match bonus',
  'deposit bonus',
]

const DEPOSIT_WITHDRAW_KEYWORDS = [
  'deposit now',
  'make a deposit',
  'withdraw funds',
  'cashier',
  'my wallet',
]

const ACCOUNT_KEYWORDS = [
  'my account',
  'account balance',
  'my balance',
  'player account',
  'account settings',
]

const RESPONSIBLE_GAMBLING_KEYWORDS = [
  'responsible gambling',
  'self-exclusion',
  'gambling awareness',
  'play responsibly',
  'gamcare',
  'gambleaware',
]

const LICENSE_KEYWORDS = [
  'licensed and regulated by',
  'our gaming license',
  'license number',
  'regulated by mga',
  'regulated by ukgc',
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(str: string, patterns: string[]): number {
  let count = 0
  for (const pattern of patterns) {
    // Patterns are treated as literal substrings, not regex — escape
    // meta chars so an entry like "rated 5.0" doesn't silently match
    // "rated 5X0".
    const regex = new RegExp(escapeRegExp(pattern), 'gi')
    const matches = str.match(regex)
    if (matches) count += matches.length
  }
  return count
}

/** Normalise a hostname for comparison: lowercase and strip a single
 *  leading `www.` so `www.casino.com`, `Casino.COM`, and `casino.com`
 *  all collapse to the same key. Without this, the external-casino
 *  link count double-counts the same site and the CASINO_KEYWORDS
 *  `includes` check on the raw hostname misses uppercase letters.
 *  Same bug family as fixed #20 (`guessBrandFromUrl`). */
function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

function getDomain(urlString: string): string | null {
  try {
    if (!urlString.startsWith('http')) return null
    return normaliseHost(new URL(urlString).hostname)
  } catch {
    return null
  }
}

function countCasinoOutboundLinks(html: string, currentUrl: string): number {
  let currentDomain = ''
  try {
    currentDomain = normaliseHost(new URL(currentUrl).hostname)
  } catch {
    /* keep '' */
  }

  const externalCasinoDomains = new Set<string>()
  const casinoTrackingLinks = new Set<string>()

  const matches = html.matchAll(HREF_RE)
  for (const match of matches) {
    const link = match[1]
    if (!link) continue
    if (
      link.startsWith('#') ||
      link.startsWith('javascript:') ||
      link.startsWith('mailto:') ||
      link.startsWith('tel:')
    ) {
      continue
    }

    const linkLower = link.toLowerCase()

    if (TRACKING_LINK_PATH_RE.test(link) || TRACKING_LINK_QUERY_RE.test(link)) {
      casinoTrackingLinks.add(link)
      continue
    }

    if (link.startsWith('http')) {
      const linkDomain = getDomain(link)
      if (linkDomain && linkDomain !== currentDomain) {
        if (CASINO_KEYWORDS.some(kw => linkDomain.includes(kw) || linkLower.includes(kw))) {
          externalCasinoDomains.add(linkDomain)
        }
      }
    }
  }

  return Math.max(externalCasinoDomains.size, casinoTrackingLinks.size)
}

export function scoreAffiliate(html: string, inputUrl: string): AffiliateScoreResult {
  const text = html ? html.toLowerCase() : ''

  if (!html || html.length < 100) {
    return {
      classification: 'NOT_AFFILIATE',
      confidence: 'ERROR',
      affiliateScore: 0,
      casinoScore: 0,
      scoreDifference: 0,
      externalCasinoLinks: 0,
      indicators: [],
      error: 'No HTML content received or content too short',
    }
  }

  let affiliateScore = 0
  let casinoScore = 0
  const indicators: string[] = []

  const externalCasinoCount = countCasinoOutboundLinks(html, inputUrl)

  // === PRIMARY DECISION FACTOR: External Casino Links ===
  if (externalCasinoCount >= 5) {
    affiliateScore += 15
    indicators.push(`Multiple outbound casino links (${externalCasinoCount}) - STRONG AFFILIATE SIGNAL`)
  } else if (externalCasinoCount >= 3) {
    affiliateScore += 10
    indicators.push(`Several outbound casino links (${externalCasinoCount})`)
  } else if (externalCasinoCount >= 1) {
    affiliateScore += 3
    indicators.push(`Some outbound casino links (${externalCasinoCount})`)
  }

  // === AFFILIATE INDICATORS ===

  // 1. Affiliate disclosure
  if (AFFILIATE_DISCLOSURES.some(p => text.includes(p))) {
    affiliateScore += 8
    indicators.push('Affiliate disclosure found')
  }

  // 2. Review/comparison language
  const reviewCount = countOccurrences(text, REVIEW_KEYWORDS)
  if (reviewCount >= 5) {
    affiliateScore += 7
    indicators.push(`Heavy review/comparison language (${reviewCount})`)
  } else if (reviewCount >= 2) {
    affiliateScore += 4
    indicators.push(`Review/comparison language (${reviewCount})`)
  }

  // 3. CTAs to other casinos
  const ctaCount = countOccurrences(text, CTA_PATTERNS)
  if (ctaCount >= 10) {
    affiliateScore += 6
    indicators.push(`Many external CTAs (${ctaCount})`)
  } else if (ctaCount >= 5) {
    affiliateScore += 3
    indicators.push(`Several CTAs (${ctaCount})`)
  }

  // 4. Bonus comparison content
  const bonusCompCount = countOccurrences(text, BONUS_COMPARISON_KEYWORDS)
  if (bonusCompCount >= 10) {
    affiliateScore += 5
    indicators.push(`Heavy bonus comparison content (${bonusCompCount})`)
  } else if (bonusCompCount >= 5) {
    affiliateScore += 2
    indicators.push(`Bonus content (${bonusCompCount})`)
  }

  // 5. Pros/cons structure
  // Require the colon form or the longer "advantages/disadvantages" —
  // bare `pros`/`cons` false-positives on "process", "prospectus",
  // "consider", "console" which appear on almost every page.
  const hasProsCons =
    (text.includes('pros:') || text.includes('advantages:')) &&
    (text.includes('cons:') || text.includes('disadvantages:'))
  if (hasProsCons) {
    affiliateScore += 5
    indicators.push('Pros/cons review structure')
  }

  // 6. Rating system
  if (/\d+(\.\d+)?\s*(\/|out of)\s*\d+|★{2,}|⭐{2,}|rating/i.test(html)) {
    affiliateScore += 3
    indicators.push('Rating system detected')
  }

  // 7. Comparison table
  if (/<table/i.test(html) && (text.includes('casino') || text.includes('bonus'))) {
    affiliateScore += 4
    indicators.push('Comparison table structure')
  }

  // 8. Affiliate-style link markers (rel=nofollow / noopener)
  if (
    /rel=["'][^"']*nofollow[^"']*["']/i.test(html) ||
    /rel=["'][^"']*noopener[^"']*["']/i.test(html)
  ) {
    affiliateScore += 5
    indicators.push('Affiliate-style link markers detected')
  }

  // === CASINO INDICATORS (counter-signals) ===

  // 1. Login + password field — only when there are no outbound casino links
  const hasLoginKeywords =
    text.includes('log in') || text.includes('sign in') || text.includes('login')
  const hasRegisterKeywords =
    text.includes('register') || text.includes('sign up') || text.includes('join now')
  const hasPasswordField =
    html.includes('type="password"') || html.includes("type='password'")
  if (
    (hasLoginKeywords || hasRegisterKeywords) &&
    hasPasswordField &&
    externalCasinoCount === 0
  ) {
    casinoScore += 12
    indicators.push('Login/registration system (CASINO)')
  }

  // 2. Deposit/withdrawal — weight reduced when affiliate score already high
  const depositCount = countOccurrences(text, DEPOSIT_WITHDRAW_KEYWORDS)
  if (depositCount >= 5 && externalCasinoCount === 0 && affiliateScore < 15) {
    casinoScore += 10
    indicators.push(`Deposit/withdrawal system (${depositCount}) (CASINO)`)
  } else if (depositCount >= 3 && externalCasinoCount === 0 && affiliateScore < 20) {
    casinoScore += 5
    indicators.push(`Payment mentions (${depositCount})`)
  }

  // 3. Account/Balance
  const accountCount = countOccurrences(text, ACCOUNT_KEYWORDS)
  if (accountCount >= 3 && externalCasinoCount === 0) {
    casinoScore += 8
    indicators.push(`Player account system (${accountCount}) (CASINO)`)
  }

  // 4. Responsible gambling tools
  const rgCount = RESPONSIBLE_GAMBLING_KEYWORDS.filter(kw => text.includes(kw)).length
  if (rgCount >= 3 && externalCasinoCount === 0) {
    casinoScore += 7
    indicators.push(`Responsible gambling tools (${rgCount}) (CASINO)`)
  }

  // 5. Gaming license info
  const licenseCount = countOccurrences(text, LICENSE_KEYWORDS)
  if (licenseCount >= 1 && externalCasinoCount === 0) {
    casinoScore += 6
    indicators.push(`Gaming license info (${licenseCount}) (CASINO)`)
  }

  // === CLASSIFICATION ===
  let classification: AffiliateClassification = 'NOT_AFFILIATE'
  let confidence: AffiliateConfidence = 'LOW'
  const scoreDifference = affiliateScore - casinoScore

  if (affiliateScore >= 25 && scoreDifference >= 10) {
    classification = 'AFFILIATE'
    confidence = affiliateScore >= 35 ? 'VERY_HIGH' : 'HIGH'
  } else if (affiliateScore >= 18 && scoreDifference >= 5) {
    classification = 'AFFILIATE'
    confidence = 'HIGH'
  } else if (externalCasinoCount >= 5) {
    classification = 'AFFILIATE'
    confidence = affiliateScore >= 20 ? 'VERY_HIGH' : 'HIGH'
  } else if (externalCasinoCount >= 3) {
    classification = 'AFFILIATE'
    confidence = affiliateScore >= 15 ? 'HIGH' : 'MEDIUM'
  } else if (affiliateScore >= 12 && scoreDifference > 0) {
    classification = 'AFFILIATE'
    confidence = 'MEDIUM'
  } else if (casinoScore >= 15 && casinoScore > affiliateScore) {
    classification = 'NOT_AFFILIATE'
    confidence = 'VERY_HIGH'
  } else if (casinoScore >= 10 && casinoScore > affiliateScore) {
    classification = 'NOT_AFFILIATE'
    confidence = 'HIGH'
  } else if (casinoScore > affiliateScore) {
    classification = 'NOT_AFFILIATE'
    confidence = 'MEDIUM'
  } else {
    classification = 'NOT_AFFILIATE'
    confidence = 'LOW'
  }

  return {
    classification,
    confidence,
    affiliateScore,
    casinoScore,
    scoreDifference,
    externalCasinoLinks: externalCasinoCount,
    indicators,
  }
}

/** Domains that should be skipped entirely (never affiliates). Mirrors
 *  the JS skip list at the top of workflow 2.3. */
const SKIP_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'vimeo.com',
  'reddit.com',
  'tiktok.com',
  'linkedin.com',
  'pinterest.com',
]

export function shouldSkipDomain(domain: string | null): boolean {
  if (!domain) return false
  const lower = domain.toLowerCase().replace(/^www\./, '')
  return SKIP_DOMAINS.some(d => lower === d || lower.endsWith('.' + d))
}
