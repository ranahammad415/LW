import { describe, it, expect } from 'vitest'
import { excludeActor, buildRecipients } from '../../../src/lib/notifyRecipients.js'

describe('excludeActor', () => {
  it('removes the actor id from the list', () => {
    expect(excludeActor(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('de-duplicates repeated ids', () => {
    expect(excludeActor(['a', 'a', 'b', 'b', 'c'], null)).toEqual(['a', 'b', 'c'])
  })

  it('filters out falsy entries', () => {
    expect(excludeActor(['a', null, undefined, '', 'b'], null)).toEqual(['a', 'b'])
  })

  it('returns an empty array for non-array input', () => {
    expect(excludeActor(null, 'x')).toEqual([])
    expect(excludeActor(undefined, 'x')).toEqual([])
  })

  it('is a no-op when actorId is null and list has no duplicates or falsies', () => {
    expect(excludeActor(['a', 'b'], null)).toEqual(['a', 'b'])
  })
})

describe('buildRecipients', () => {
  it('merges multiple lists, removes the actor, and de-duplicates', () => {
    expect(
      buildRecipients('me', ['a', 'b'], ['b', 'me', 'c'], [null, 'd'])
    ).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles empty or non-array lists gracefully', () => {
    expect(buildRecipients('me', [], null, undefined, ['a'])).toEqual(['a'])
  })
})
