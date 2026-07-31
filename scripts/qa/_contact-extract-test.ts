/**
 * LGP-207 — Contact extractor v2 test harness.
 *
 * No test runner is configured in this repo, so this is a standalone
 * assertion script (same convention as the other scripts/qa/_*.ts). It
 * exercises lib/contact-extraction/extract.ts against inline HTML
 * fixtures covering every extraction path + the precision gate, and
 * exits non-zero if any assertion fails.
 *
 *   npx tsx scripts/qa/_contact-extract-test.ts
 */
import { extractContacts, type ContactResult } from '../../lib/contact-extraction/extract'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
    return
  }
  console.log(`✓ ${name}`)
}

const BASE = 'https://acme-casino.example'

function methodsFor(r: ContactResult, kind: string, value: string): string[] {
  return r.items.filter(i => i.kind === kind && i.value.toLowerCase() === value.toLowerCase()).map(i => i.method)
}

// ---------------------------------------------------------------------------
// 1. mailto + tel — highest confidence, correct provenance
// ---------------------------------------------------------------------------
{
  const html = `
    <html><body>
      <a href="mailto:Hello@Acme-Casino.example">email us</a>
      <a href="tel:+442079460958">call us</a>
    </body></html>`
  const r = extractContacts(html, BASE)
  check('mailto email captured + lowercased', r.emails.includes('hello@acme-casino.example'))
  check('mailto method = mailto', methodsFor(r, 'email', 'hello@acme-casino.example').includes('mailto'))
  check('tel phone normalised to E.164', r.phones.includes('+442079460958'), JSON.stringify(r.phones))
  check('tel method = tel', methodsFor(r, 'phone', '+442079460958').includes('tel'))
}

// ---------------------------------------------------------------------------
// 2. Phone precision gate — junk numbers must NOT become phones
// ---------------------------------------------------------------------------
{
  const html = `
    <html><body>
      <p>Get a 1000 bonus + 200 free spins! Established 2019.</p>
      <p>Reference ID: 123456 order 000111222</p>
      <p>Reach us on +44 20 7946 0958 anytime.</p>
    </body></html>`
  const r = extractContacts(html, BASE)
  check('valid text phone survives the gate', r.phones.includes('+442079460958'), JSON.stringify(r.phones))
  check('bonus/id/year figures rejected as phones', r.phones.length === 1, `got ${JSON.stringify(r.phones)}`)
}

// ---------------------------------------------------------------------------
// 3. Obfuscated email (at/dot + HTML entities) — decoded + tagged
// ---------------------------------------------------------------------------
{
  const html = `<html><body>
     <p>Contact: support (at) acme-casino dot example</p>
     <p>Or admin&#64;acme-casino&#46;example</p>
  </body></html>`
  const r = extractContacts(html, BASE)
  check('at/dot obfuscation decoded', r.emails.includes('support@acme-casino.example'), JSON.stringify(r.emails))
  check('at/dot email tagged obfuscated', methodsFor(r, 'email', 'support@acme-casino.example').includes('obfuscated-email'))
  check('HTML-entity obfuscation decoded', r.emails.includes('admin@acme-casino.example'), JSON.stringify(r.emails))
}

// ---------------------------------------------------------------------------
// 4. Image/asset "emails" and noise domains rejected
// ---------------------------------------------------------------------------
{
  const html = `<html><body>
     <img src="logo@2x.png"> <img src="hero@3x.webp">
     <p>real@acme-casino.example</p>
     <p>noise@sentry.io</p>
  </body></html>`
  const r = extractContacts(html, BASE)
  check('asset @2x.png not an email', !r.emails.some(e => e.endsWith('.png')))
  check('sentry.io noise domain filtered', !r.emails.includes('noise@sentry.io'))
  check('real email still captured', r.emails.includes('real@acme-casino.example'))
}

// ---------------------------------------------------------------------------
// 5. Socials — platform detection + share-link exclusion
// ---------------------------------------------------------------------------
{
  const html = `<html><body>
     <a href="https://t.me/acmecasino">telegram</a>
     <a href="https://wa.me/442071838750">whatsapp</a>
     <a href="https://x.com/acmecasino">x</a>
     <a href="https://twitter.com/intent/tweet?text=hi">share</a>
     <a href="https://facebook.com/sharer/sharer.php?u=x">fb share</a>
     <a href="https://instagram.com/acme.casino">ig</a>
  </body></html>`
  const r = extractContacts(html, BASE)
  const platforms = new Set(r.socials.map(s => s.platform))
  check('telegram social detected', platforms.has('telegram'))
  check('whatsapp social detected', platforms.has('whatsapp'))
  check('x social detected', platforms.has('x'))
  check('instagram social detected', platforms.has('instagram'))
  check('twitter intent/share excluded', !r.socials.some(s => s.url.includes('intent')))
  check('facebook sharer excluded', !r.socials.some(s => s.url.includes('sharer')))
}

// ---------------------------------------------------------------------------
// 6. Contact links ranked best-first (contact > impressum > about)
// ---------------------------------------------------------------------------
{
  const html = `<html><body>
     <a href="/about-us">About</a>
     <a href="/impressum">Impressum</a>
     <a href="/contact">Contact us</a>
  </body></html>`
  const r = extractContacts(html, BASE)
  check('contactPageUrl points at /contact (top rank)', (r.contactPageUrl ?? '').endsWith('/contact'), r.contactPageUrl ?? 'null')
  check('all three contact-shaped links captured', r.contactLinks.length === 3, `${r.contactLinks.length}`)
}

// ---------------------------------------------------------------------------
// 7. Contact form detection
// ---------------------------------------------------------------------------
{
  const html = `<html><body>
     <form action="/send"><input type="email" name="email"><textarea name="message"></textarea></form>
  </body></html>`
  const r = extractContacts(html, `${BASE}/contact`)
  check('contact form detected', r.contactForms.length === 1)
  check('form item carries contact-form method', r.items.some(i => i.kind === 'contact_form' && i.method === 'contact-form'))
}

// ---------------------------------------------------------------------------
// 8. JSON-LD Organization — email/phone/address/sameAs
// ---------------------------------------------------------------------------
{
  const html = `<html><head>
     <script type="application/ld+json">${JSON.stringify({
       '@context': 'https://schema.org',
       '@type': 'Organization',
       email: 'mailto:info@acme-casino.example',
       telephone: '+44 20 7946 0958',
       address: {
         '@type': 'PostalAddress',
         streetAddress: '1 Test St',
         addressLocality: 'London',
         postalCode: 'EC1A 1BB',
         addressCountry: 'GB',
       },
       sameAs: ['https://t.me/acmecasino', 'https://linkedin.com/company/acme'],
     })}</script>
  </head><body></body></html>`
  const r = extractContacts(html, BASE)
  check('JSON-LD email captured', r.emails.includes('info@acme-casino.example'))
  check('JSON-LD email method = json-ld', methodsFor(r, 'email', 'info@acme-casino.example').includes('json-ld'))
  check('JSON-LD phone captured', r.phones.includes('+442079460958'))
  check('JSON-LD address assembled', (r.address ?? '').includes('London'), r.address ?? 'null')
  check('JSON-LD sameAs linkedin social', r.socials.some(s => s.platform === 'linkedin'))
}

// ---------------------------------------------------------------------------
// 9. Multi-page blob — sourceUrl attribution is the real page
// ---------------------------------------------------------------------------
{
  const html = `<!-- PAGE: https://acme-casino.example/ -->
     <a href="/contact">contact</a>
     <!-- PAGE: https://acme-casino.example/contact -->
     <a href="mailto:team@acme-casino.example">mail</a>`
  const r = extractContacts(html, BASE)
  const emailItem = r.items.find(i => i.kind === 'email' && i.value === 'team@acme-casino.example')
  check('email sourceUrl is the /contact page, not homepage', emailItem?.sourceUrl === 'https://acme-casino.example/contact', emailItem?.sourceUrl ?? 'null')
  check('raw.pages counts both pages', r.raw.pages === 2, `${r.raw.pages}`)
}

// ---------------------------------------------------------------------------
// 10. Empty / garbage input never throws
// ---------------------------------------------------------------------------
{
  const r = extractContacts('', BASE)
  check('empty html → empty result, no throw', r.emails.length === 0 && r.items.length === 0)
  const r2 = extractContacts('<html><body>nothing here</body></html>', BASE)
  check('no-contact html → empty arrays', r2.emails.length === 0 && r2.phones.length === 0 && r2.contactPageUrl === null)
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFAILURES:\n' + failures.join('\n'))
  process.exit(1)
}
console.log('All contact-extractor assertions passed ✅')
