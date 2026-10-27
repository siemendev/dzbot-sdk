import type { Dzbot } from './client'
import type { AnyDzbotEvent } from './events'
import { DzbotError } from './errors'

interface LiveGrant {
  hubUrl: string
  token: string
  topics: string[]
  expiresAt: string
}

/** The part of the browser's EventSource the SDK needs; Node 22+ has one built in, older Node can pass the `eventsource` package. */
export interface EventSourceLike {
  readonly readyState: number
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  onopen: ((event: unknown) => void) | null
  close(): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

export interface SubscribeOptions {
  onError?: (error: unknown) => void
  /** Called with the topics the token covers once connected: names the caller may not read are left out. */
  onOpen?: (topics: string[]) => void
  eventSource?: EventSourceFactory
}

export interface Subscription {
  close(): void
}

const CLOSED = 2
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
const RENEW_BEFORE_MS = 60_000
const SEEN_IDS = 500

/** A refused grant (revoked sign-in, removed key, rights gone) ends the subscription instead of retrying. */
const isRefused = (error: unknown) => error instanceof DzbotError && (error.status === 401 || error.status === 403)

/**
 * Live events in the browser or on a server, through dzbot's event hub. A hub token lives a few minutes; the
 * subscription fetches the next one before it runs out and opens the new connection before closing the old,
 * so a revoked sign-in or key stops receiving within minutes and nothing is delivered twice.
 */
export class LiveEvents {
  /** Anything that can POST to the dzbot API with the caller's credentials — the `Dzbot` client, usually. */
  constructor(private readonly client: Pick<Dzbot, 'post'>) {}

  /** Delivers every event of these names the caller may read, reconnecting by itself until `close()`. */
  subscribe(names: string[], handler: (event: AnyDzbotEvent) => void, options: SubscribeOptions = {}): Subscription {
    const create = options.eventSource ?? defaultEventSource()
    const wanted = new Set(names)
    const seen: string[] = []
    let source: EventSourceLike | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let closed = false

    const stopTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    // A failed renewal keeps the open connection until the hub ends it with the old token.
    const retry = () => {
      if (closed) return
      stopTimer()
      if (source?.readyState === CLOSED) {
        source.close()
        source = null
      }
      timer = setTimeout(() => void connect(), BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)])
    }

    const deliver = (data: string) => {
      let event: AnyDzbotEvent
      try {
        event = JSON.parse(data) as AnyDzbotEvent
      } catch (e) {
        options.onError?.(e)
        return
      }
      if (seen.includes(event.id)) return
      seen.push(event.id)
      if (seen.length > SEEN_IDS) seen.shift()
      if (wanted.has(event.name)) handler(event)
    }

    const connect = async () => {
      if (closed) return
      let grant: LiveGrant
      try {
        grant = await this.client.post<LiveGrant>('/api/developer/live', { events: names })
      } catch (e) {
        options.onError?.(e)
        if (isRefused(e)) {
          closed = true
          stopTimer()
          source?.close()
          source = null
          return
        }
        retry()
        return
      }
      if (closed) return
      if (grant.topics.length === 0) {
        options.onError?.(new Error(`None of these events is readable with this key or token: ${names.join(', ')}`))
        closed = true
        source?.close()
        source = null
        return
      }
      const params = new URLSearchParams()
      for (const topic of grant.topics) params.append('topic', topic)
      params.append('authorization', grant.token)
      const previous = source
      const next = create(`${grant.hubUrl}?${params.toString()}`)
      source = next
      next.onopen = () => {
        failures = 0
        previous?.close()
        options.onOpen?.(grant.topics)
      }
      next.onmessage = (message) => deliver(message.data)
      next.onerror = (e) => {
        if (next === source && next.readyState === CLOSED) {
          options.onError?.(e)
          retry()
        }
      }
      stopTimer()
      const renewIn = Date.parse(grant.expiresAt) - Date.now() - RENEW_BEFORE_MS
      if (Number.isFinite(renewIn)) {
        timer = setTimeout(() => void connect(), Math.max(renewIn, 5000))
      }
    }

    void connect()
    return {
      close() {
        closed = true
        stopTimer()
        source?.close()
        source = null
      },
    }
  }
}

function defaultEventSource(): EventSourceFactory {
  const EventSourceCtor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource
  if (!EventSourceCtor) {
    throw new Error('No EventSource here: use Node 22+, or pass { eventSource: (url) => new EventSource(url) } from the eventsource package')
  }
  return (url) => new EventSourceCtor(url)
}
