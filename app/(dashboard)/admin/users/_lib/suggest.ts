/**
 * Memorable user-credential suggestions for the admin "Add user" form.
 *
 * Username:     <adjective>.<animal><nn>           e.g. swift.heron42
 * Display name: <Adjective> <Animal>               e.g. Swift Heron
 * Password:     <word>-<word>-<word>-<nnn>         e.g. purple-canyon-river-471
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
  'summit', 'valley', 'hollow', 'birch', 'poppy', 'thistle',
]

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Produces a coherent {username, displayName} pair so the two fields
 * tell the same story (e.g. swift.heron42 / Swift Heron) when the
 * admin uses both regenerate buttons in sequence.
 */
export function suggestIdentity(): { username: string; displayName: string } {
  const adj = pick(ADJECTIVES)
  const animal = pick(ANIMALS)
  const num = Math.floor(Math.random() * 90) + 10 // 10–99
  return {
    username: `${adj}.${animal}${num}`,
    displayName: `${capitalize(adj)} ${capitalize(animal)}`,
  }
}

export function suggestUsername(): string {
  return suggestIdentity().username
}

export function suggestDisplayName(): string {
  return suggestIdentity().displayName
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
