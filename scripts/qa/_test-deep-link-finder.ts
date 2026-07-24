import { findDeepLinkCandidates } from '@/lib/stag-extraction/deep-link-candidates'

const html = `
<html><body>
<nav>
  <a href="/about" class="nav-link">About</a>
  <a href="/contact" class="nav-link">Contact</a>
</nav>
<header class="site-header">
  <a href="/login" class="nav-item">Login</a>
</header>
<article>
  <h2>Best casino</h2>
  <p>Check this out:</p>
  <a href="/join-now?tag=stale123">Sign up now</a>
  <a href="/promo/welcome-bonus">Get bonus</a>
  <a href="/game/blackjack">Blackjack</a>
  <a href="/blog/best-slots-2024">Best slots article</a>
  <a href="https://external.example.com/track?a=1">Outbound</a>
  <a href="/deposit-now" class="cta-button">Deposit now</a>
  <a href="/privacy">Privacy policy</a>
  <a href="/welcome-offer">Welcome offer</a>
  <a href="/refer-a-friend">Refer a friend</a>
</article>
</body></html>
`

const cands = findDeepLinkCandidates(html, 'https://casino-review.com/best-casinos', 10)
console.log('deep-link candidates found:')
for (const c of cands) {
  console.log(`  conf=${c.confidence}  reasons=${c.reason.join(',')}  ${c.url}`)
}
console.log(`\nTotal: ${cands.length}`)
