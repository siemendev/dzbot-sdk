import { expect, it, vi } from 'vitest'
import { Dzbot } from '../src/client'
import type { EventSourceLike } from '../src/live'

class FakeEventSource implements EventSourceLike {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onopen: ((event: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {}
  close() {
    this.closed = true
  }
}

it('subscribes with the granted topics and delivers only the asked names', async () => {
  const bodies: string[] = []
  const fetch = async (_url: string, init: RequestInit = {}) => {
    bodies.push(String(init.body))
    return new Response(JSON.stringify({
      hubUrl: 'https://api.dzbot.de/.well-known/mercure',
      token: 'jwt',
      topics: ['urn:dzbot:events:server:12:log.player_kill'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }), { status: 200 })
  }
  const sources: FakeEventSource[] = []
  const received: string[] = []
  const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch })
  const subscription = dzbot.events.subscribe(['log.player_kill'], (event) => void received.push(event.name), {
    eventSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(JSON.parse(bodies[0])).toEqual({ events: ['log.player_kill'] })
  const url = new URL(sources[0].url)
  expect(url.searchParams.getAll('topic')).toEqual(['urn:dzbot:events:server:12:log.player_kill'])
  expect(url.searchParams.get('authorization')).toBe('jwt')

  sources[0].onmessage?.({ data: JSON.stringify({ id: '1', name: 'log.player_kill', organizationId: 1, serverId: 12, occurredAt: '', payload: {} }) })
  sources[0].onmessage?.({ data: JSON.stringify({ id: '2', name: 'order.created', organizationId: 1, serverId: 12, occurredAt: '', payload: {} }) })
  expect(received).toEqual(['log.player_kill'])

  subscription.close()
  expect(sources[0].closed).toBe(true)
})

const grantFetch = (responses: Array<{ status: number; body: unknown }>) => async () => {
  const next = responses.shift() ?? { status: 500, body: {} }
  return new Response(JSON.stringify(next.body), { status: next.status })
}

const grant = (token: string, expiresInMs: number) => ({
  status: 200,
  body: { hubUrl: 'https://api.dzbot.de/.well-known/mercure', token, topics: ['urn:dzbot:events:server:12:order.created'], expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
})

it('opens the next connection before closing the old one and delivers an event only once', async () => {
  vi.useFakeTimers()
  const sources: FakeEventSource[] = []
  const received: string[] = []
  const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch: grantFetch([grant('first', 65_000), grant('second', 300_000)]) })
  dzbot.events.subscribe(['order.created'], (event) => void received.push(event.id), {
    eventSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  })
  await vi.advanceTimersByTimeAsync(0)
  sources[0].onopen?.({})
  const event = JSON.stringify({ id: 'e1', name: 'order.created', organizationId: 1, serverId: 12, occurredAt: '', payload: {} })
  sources[0].onmessage?.({ data: event })

  await vi.advanceTimersByTimeAsync(5_000)
  expect(sources).toHaveLength(2)
  expect(new URL(sources[1].url).searchParams.get('authorization')).toBe('second')
  expect(sources[0].closed).toBe(false)
  sources[1].onopen?.({})
  expect(sources[0].closed).toBe(true)

  sources[1].onmessage?.({ data: event })
  expect(received).toEqual(['e1'])
  vi.useRealTimers()
})

it('ends the subscription when dzbot refuses the grant', async () => {
  vi.useFakeTimers()
  const sources: FakeEventSource[] = []
  const errors: unknown[] = []
  const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch: grantFetch([grant('first', 65_000), { status: 401, body: { error: 'invalid_token' } }]) })
  dzbot.events.subscribe(['order.created'], () => undefined, {
    onError: (e) => void errors.push(e),
    eventSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(errors).toHaveLength(1)
  expect(sources[0].closed).toBe(true)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(sources).toHaveLength(1)
  vi.useRealTimers()
})
