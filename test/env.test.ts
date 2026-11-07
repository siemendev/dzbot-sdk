import { describe, expect, it } from 'vitest'
import { withoutTrailingSlashes } from '../src/env'

describe('withoutTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(withoutTrailingSlashes('https://api.dzbot.de///')).toBe('https://api.dzbot.de')
    expect(withoutTrailingSlashes('https://api.dzbot.de/v1')).toBe('https://api.dzbot.de/v1')
    expect(withoutTrailingSlashes('///')).toBe('')
  })

  it('stays linear on long runs of slashes', () => {
    const started = performance.now()
    withoutTrailingSlashes('/'.repeat(100_000) + 'x')
    expect(performance.now() - started).toBeLessThan(100)
  })
})
