import { expect, it, vi } from 'vitest'
import { Dzbot } from '../src/client'
import type { EventSourceLike } from '../src/live'
import { openEventStream } from '../src/eventStream'

class FakeEventSource implements EventSourceLike {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onopen: ((event: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string, readonly token: string) {}
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
    eventSource: (url, token) => {
      const source = new FakeEventSource(url, token)
      sources.push(source)
      return source
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(JSON.parse(bodies[0])).toEqual({ events: ['log.player_kill'] })
  const url = new URL(sources[0].url)
  expect(url.searchParams.getAll('match')).toEqual(['urn:dzbot:events:server:12:log.player_kill'])
  expect(url.searchParams.has('authorization')).toBe(false)
  expect(sources[0].token).toBe('jwt')

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
    eventSource: (url, token) => {
      const source = new FakeEventSource(url, token)
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
  expect(sources[1].token).toBe('second')
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
    eventSource: (url, token) => {
      const source = new FakeEventSource(url, token)
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

const recordSources = (sources: FakeEventSource[]) => (url: string, token: string) => {
  const source = new FakeEventSource(url, token)
  sources.push(source)
  return source
}

it('keeps the open connection when the renewed one fails before opening, and closes it once a later one opens', async () => {
  vi.useFakeTimers()
  const sources: FakeEventSource[] = []
  const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch: grantFetch([grant('first', 65_000), grant('second', 300_000), grant('third', 300_000)]) })
  const subscription = dzbot.events.subscribe(['order.created'], () => undefined, { onError: () => undefined, eventSource: recordSources(sources) })
  await vi.advanceTimersByTimeAsync(0)
  sources[0].onopen?.({})

  await vi.advanceTimersByTimeAsync(5_000)
  expect(sources).toHaveLength(2)
  sources[1].readyState = 2
  sources[1].onerror?.({})
  expect(sources[1].closed).toBe(true)
  expect(sources[0].closed).toBe(false)

  await vi.advanceTimersByTimeAsync(1_000)
  expect(sources).toHaveLength(3)
  sources[2].onopen?.({})
  expect(sources[0].closed).toBe(true)

  subscription.close()
  expect(sources.every((source) => source.closed)).toBe(true)
  vi.useRealTimers()
})

it('starts one connection when the open one fails while a renewal is fetching its grant', async () => {
  vi.useFakeTimers()
  const sources: FakeEventSource[] = []
  let release: () => void = () => undefined
  let calls = 0
  const fetch = async () => {
    calls++
    if (calls === 2) await new Promise<void>((resolve) => { release = resolve })
    return new Response(JSON.stringify(grant(`t${calls}`, 65_000).body), { status: 200 })
  }
  const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch })
  dzbot.events.subscribe(['order.created'], () => undefined, { onError: () => undefined, eventSource: recordSources(sources) })
  await vi.advanceTimersByTimeAsync(0)
  sources[0].onopen?.({})

  await vi.advanceTimersByTimeAsync(5_000)
  expect(calls).toBe(2)
  sources[0].readyState = 2
  sources[0].onerror?.({})
  await vi.advanceTimersByTimeAsync(30_000)
  expect(calls).toBe(2)

  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(sources).toHaveLength(2)
  expect(sources[1].token).toBe('t2')
  vi.useRealTimers()
})

it('reads the event stream with the token in the Authorization header', async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const encoder = new TextEncoder()
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), headers: init.headers as Record<string, string> })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(':\n\nid: urn:uuid:1\ndata: {"a":\n'))
        controller.enqueue(encoder.encode('data: 1}\n\nevent: mercure\ndata: {"type":"subscription"}\n\ndata: second\r\n\r\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  const messages: string[] = []
  const errors: unknown[] = []
  let opened = false
  const stream = openEventStream('https://hub/.well-known/mercure?match=t', 'jwt', fetch as typeof globalThis.fetch)
  stream.onopen = () => void (opened = true)
  stream.onmessage = (message) => void messages.push(message.data)
  stream.onerror = (error) => void errors.push(error)
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(requests[0].url).toBe('https://hub/.well-known/mercure?match=t')
  expect(requests[0].headers.Authorization).toBe('Bearer jwt')
  expect(opened).toBe(true)
  expect(messages).toEqual(['{"a":\n1}', 'second'])
  expect(errors).toHaveLength(1)
  expect(stream.readyState).toBe(2)
})

it('reports and closes the stream when the hub refuses the token', async () => {
  const errors: unknown[] = []
  let opened = false
  const stream = openEventStream('https://hub/', 'expired', (async () => new Response('', { status: 401 })) as typeof globalThis.fetch)
  stream.onopen = () => void (opened = true)
  stream.onerror = (error) => void errors.push(error)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(opened).toBe(false)
  expect(errors).toHaveLength(1)
  expect(stream.readyState).toBe(2)
})
