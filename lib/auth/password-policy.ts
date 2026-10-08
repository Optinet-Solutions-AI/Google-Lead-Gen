import { randomInt } from 'node:crypto'

/**
 * One definition of "a safe password", used by every place that sets one.
 *
 * The rules were previously just "at least 12 characters", repeated in three
 * files. That let an admin-issued temporary password be replaced with
 * `aaaaaaaaaaaa` on first login, which is technically compliant and no use to
 * anybody.
 */

export const MIN_PASSWORD_LENGTH = 12

export type PasswordCheck = { ok: true } | { ok: false; error: string }

/**
 * Rejects what is actually weak rather than imposing arbitrary composition
 * rules: length first (it dominates), then enough variety that a short-ish
 * password is not a single dictionary word, then the handful of patterns
 * people reach for when a form nags them.
 */
export function checkPassword(password: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  if (password.length > 128) {
    return { ok: false, error: 'Password must be 128 characters or fewer.' }
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(password)).length
  if (classes < 3) {
    return {
      ok: false,
      error:
        'Use at least three of: lowercase, uppercase, numbers, symbols.',
    }
  }

  // A password made of one repeated character or a straight run passes a
  // naive length check and nothing else.
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, error: 'Password cannot be the same character repeated.' }
  }
  if (/^(?:0123456789|1234567890|abcdefghijkl|qwertyuiop)/i.test(password)) {
    return { ok: false, error: 'Password cannot start with a keyboard or counting run.' }
  }
  if (/password|letmein|welcome|admin123|qwerty/i.test(password)) {
    return { ok: false, error: 'Password contains a word that is guessed first in every attack.' }
  }

  return { ok: true }
}

// Ambiguous glyphs are left out: a temporary password gets read off a screen
// and typed by hand, and 0/O, 1/l/I cost more support time than they add
// entropy.
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!@#$%&*+=?'

/**
 * A temporary password: 16 characters, at least one from each class, drawn
 * with a CSPRNG and shuffled so the guaranteed characters are not always in
 * the same positions.
 *
 * At 16 characters over this alphabet that is ~87 bits of entropy — far past
 * anything that matters for a credential meant to be replaced on first login.
 */
export function generateTemporaryPassword(length = 16): string {
  const all = LOWER + UPPER + DIGIT + SYMBOL
  const chars: string[] = [
    pick(LOWER),
    pick(UPPER),
    pick(DIGIT),
    pick(SYMBOL),
  ]
  while (chars.length < length) chars.push(pick(all))

  // Fisher–Yates with crypto randomness; a biased shuffle would leak where
  // the guaranteed classes sit.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }

  const out = chars.join('')
  // Belt and braces: never hand out something our own validator rejects.
  return checkPassword(out).ok ? out : generateTemporaryPassword(length)
}

function pick(set: string): string {
  return set[randomInt(0, set.length)]!
}
