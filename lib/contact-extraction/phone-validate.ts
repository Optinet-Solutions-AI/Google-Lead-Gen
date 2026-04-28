/**
 * Phone-number validator using libphonenumber-js. Drops the bulk of
 * regex false-positives (product SKUs, postal codes, dates) and
 * normalises survivors to international E.164 format.
 *
 * Pass the lead's country_code (ISO 3166 alpha-2) so locally-written
 * numbers like "(0)20 7946 0958" can be resolved to a global format.
 */
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'

const COUNTRY_RE = /^[A-Z]{2}$/

export function validatePhones(
  candidates: string[],
  countryCode: string | null | undefined,
): string[] {
  const country = countryCode && COUNTRY_RE.test(countryCode)
    ? (countryCode as CountryCode)
    : undefined

  const valid = new Set<string>()
  for (const raw of candidates) {
    if (!raw) continue
    try {
      const parsed = parsePhoneNumberFromString(raw, country)
      if (parsed && parsed.isValid()) {
        valid.add(parsed.formatInternational())
      }
    } catch {
      // skip
    }
  }
  return Array.from(valid)
}
