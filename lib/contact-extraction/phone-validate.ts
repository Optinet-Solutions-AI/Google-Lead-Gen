/**
 * Phone-number validator using libphonenumber-js. Drops the bulk of
 * regex false-positives (product SKUs, postal codes, dates) and
 * normalises survivors to international E.164 format.
 *
 * Pass the lead's country_code (ISO 3166 alpha-2) so locally-written
 * numbers like "(0)20 7946 0958" can be resolved to a global format.
 */
import {
  parsePhoneNumberFromString as parseWithMeta,
  type CountryCode,
  type MetadataJson,
} from 'libphonenumber-js/core'
import rawPhoneMetadata from 'libphonenumber-js/metadata.min.json'

// Same interop hardening as extract.ts: libphonenumber-js's default entry
// loads metadata via an internal require that some ESM/CJS loaders (tsx,
// certain bundler configs) return double-wrapped as `{ default }`, making
// every parse throw. That throw is swallowed by the try/catch below, which
// would silently drop EVERY phone. Passing metadata.min.json ourselves
// (normalising the possible default-wrap) keeps validation deterministic
// across Next.js server, scripts, and tests.
const PHONE_METADATA = (
  (rawPhoneMetadata as unknown as { countries?: unknown }).countries
    ? rawPhoneMetadata
    : (rawPhoneMetadata as unknown as { default: unknown }).default
) as MetadataJson

const COUNTRY_RE = /^[A-Z]{2}$/

export function validatePhones(
  candidates: string[],
  countryCode: string | null | undefined,
): string[] {
  const country = countryCode && COUNTRY_RE.test(countryCode)
    ? (countryCode as CountryCode)
    : undefined

  // Signal that the page uses international (+) formatting: if any candidate
  // is E.164-prefixed, bare digit runs are more likely real phone numbers
  // that simply lost their '+' in extraction than incidental SKUs/dates.
  const sawIntl = candidates.some(c => typeof c === 'string' && c.trim().startsWith('+'))

  const valid = new Set<string>()
  for (const raw of candidates) {
    if (!raw) continue
    let candidate = raw.trim()
    if (!country && !candidate.startsWith('+')) {
      // No country anchor. A bare run is ambiguous — libphonenumber would
      // call any 10-digit run a valid US/CA number. Only attempt it when the
      // page shows international formatting elsewhere AND the run is long
      // enough (≥11 digits) to already carry a country code. Prefix '+' and
      // let isValid() reject wrong guesses (national numbers with a trunk
      // '0' → invalid country code → dropped). Genuine national-format
      // numbers without a country code still need country_code set — that's
      // the proper fix for those, not a guess here.
      const digits = candidate.replace(/\D/g, '')
      if (!sawIntl || digits.length < 11) continue
      candidate = '+' + digits
    }
    try {
      const parsed = country
        ? parseWithMeta(candidate, country, PHONE_METADATA)
        : parseWithMeta(candidate, PHONE_METADATA)
      if (parsed && parsed.isValid()) {
        valid.add(parsed.formatInternational())
      }
    } catch {
      // skip
    }
  }
  return Array.from(valid)
}
