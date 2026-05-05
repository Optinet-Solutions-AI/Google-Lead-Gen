/**
 * Memorable user-credential suggestions for the admin "Add user" form.
 *
 * Email format: <adjective>.<animal><nn>@rooster.app
 *   e.g. swift.heron42@rooster.app — easy to read out loud, hard to typo.
 *
 * Password format: <word>-<word>-<word>-<nnn>
 *   e.g. purple-canyon-river-471 — passes most password complexity rules
 *   while staying memorable. ~33 bits of entropy from the words alone,
 *   plus the 3-digit suffix.
 *
 * Both lists are kept short and PG so the suggestions never produce
 * something awkward to read in front of a colleague.
 */

const ADJECTIVES = [
  'swift', 'bright', 'clever', 'quick', 'bold', 'gentle', 'calm', 'brave',
  'merry', 'cosmic', 'silent', 'lucky', 'cheery', 'royal', 'noble', 'sunny',
  'misty', 'amber', 'crisp', 'velvet', 'mellow', 'starry', 'crimson', 'jade',
]

const ANIMALS = [
  'heron', 'fox', 'otter', 'falcon', 'lynx', 'bison', 'wolf', 'eagle',
  'hawk', 'panda', 'tiger', 'jaguar', 'badger', 'koala', 'gecko', 'sparrow',
  'orca', 'puffin', 'lemur', 'raven', 'finch', 'mantis', 'crane', 'shrew',
]

const PASSWORD_WORDS = [
  'purple', 'canyon', 'river', 'forest', 'mountain', 'ocean', 'meadow',
  'glacier', 'horizon', 'thunder', 'crystal', 'ember', 'lantern', 'compass',
  'harvest', 'cobalt', 'maple', 'cedar', 'willow', 'ivory', 'ruby', 'topaz',
  'opal', 'sienna', 'sapphire', 'pebble', 'driftwood', 'sandstone', 'fern',
  'summit', 'valley', 'meadow', 'hollow', 'birch', 'poppy', 'thistle',
]

const EMAIL_DOMAIN = 'rooster.app'

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function suggestEmail(): string {
  const adj = pick(ADJECTIVES)
  const animal = pick(ANIMALS)
  const num = Math.floor(Math.random() * 90) + 10 // 10–99
  return `${adj}.${animal}${num}@${EMAIL_DOMAIN}`
}

export function suggestPassword(): string {
  // Pick 3 distinct words to avoid `crystal-crystal-crystal-…`.
  const pool = [...PASSWORD_WORDS]
  const picked: string[] = []
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(idx, 1)[0]!)
  }
  const num = Math.floor(Math.random() * 900) + 100 // 100–999
  return `${picked.join('-')}-${num}`
}
