import type { Dzbot } from './client'
import type { AnyDzbotEvent } from './events'
import { DzbotError } from './errors'
import { openEventStream } from './eventStream'

interface LiveGrant {
  hubUrl: string
  token: string
  topics: string[]
  expiresAt: string
}

/** One connection to the event hub, shaped like the browser's EventSource. */
export interface EventSourceLike {
  readonly readyState: number
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  onopen: ((event: unknown) => void) | null
  close(): void
}

/** Opens a connection that sends `token` as `Authorization: Bearer`; the hub refuses tokens in the URL. */
export type EventSourceFactory = (url: string, token: string) => EventSourceLike

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
/**
 * Where a subscription stands. `live` is the connection that currently delivers events; during a renewal it stays
 * open until the next one (`next`) is open, and survives a renewal that fails.
 */
type ConnectionState =
  | { kind: 'granting'; live: EventSourceLike | null }
  | { kind: 'opening'; live: EventSourceLike | null; next: EventSourceLike }
  | { kind: 'open'; live: EventSourceLike }
  | { kind: 'waiting'; live: EventSourceLike | null }
  | { kind: 'closed' }

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
    const create = options.eventSource ?? ((url: string, token: string) => openEventStream(url, token))
    const wanted = new Set(names)
    const seen: string[] = []
    let state: ConnectionState = { kind: 'granting', live: null }
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let attempt = 0

    const after = (ms: number, action: () => void) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        action()
      }, ms)
    }

    const end = () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (state.kind !== 'closed') {
        state.live?.close()
        if (state.kind === 'opening') state.next.close()
      }
      state = { kind: 'closed' }
    }

    // A failed renewal keeps the open connection until the hub ends it with the old token.
    const backOff = (live: EventSourceLike | null) => {
      state = { kind: 'waiting', live }
      after(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)], () => {
        if (state.kind === 'waiting') void grant(state.live)
      })
    }

    const renew = () => {
      if (state.kind === 'open') void grant(state.live)
      else if (state.kind === 'opening') {
        state.next.close()
        void grant(state.live)
      }
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

    const failed = (source: EventSourceLike, error: unknown) => {
      if (state.kind === 'closed') return
      if (state.kind === 'opening' && state.next === source) {
        source.close()
        options.onError?.(error)
        backOff(state.live?.readyState === CLOSED ? null : state.live)
        return
      }
      if (state.live !== source) return
      source.close()
      if (state.kind === 'open') {
        options.onError?.(error)
        backOff(null)
        return
      }
      if (state.kind !== 'opening') options.onError?.(error)
      state = { ...state, live: null }
    }

    const open = (hubUrl: string, token: string, topics: string[], live: EventSourceLike | null) => {
      const params = new URLSearchParams()
      for (const topic of topics) params.append('match', topic)
      const next = create(`${hubUrl}?${params.toString()}`, token)
      state = { kind: 'opening', live, next }
      next.onopen = () => {
        if (state.kind !== 'opening' || state.next !== next) return
        failures = 0
        state.live?.close()
        state = { kind: 'open', live: next }
        options.onOpen?.(topics)
      }
      next.onmessage = (message) => deliver(message.data)
      next.onerror = (e) => {
        if (next.readyState === CLOSED) failed(next, e)
      }
    }

    const grant = async (live: EventSourceLike | null) => {
      const mine = ++attempt
      state = { kind: 'granting', live }
      let granted: LiveGrant
      try {
        granted = await this.client.post<LiveGrant>('/api/developer/live', { events: names })
      } catch (e) {
        if (state.kind !== 'granting' || attempt !== mine) return
        options.onError?.(e)
        if (isRefused(e)) end()
        else backOff(state.live)
        return
      }
      if (state.kind !== 'granting' || attempt !== mine) return
      if (granted.topics.length === 0) {
        options.onError?.(new Error(`None of these events is readable with this key or token: ${names.join(', ')}`))
        end()
        return
      }
      open(granted.hubUrl, granted.token, granted.topics, state.live)
      const renewIn = Date.parse(granted.expiresAt) - Date.now() - RENEW_BEFORE_MS
      if (Number.isFinite(renewIn)) after(Math.max(renewIn, 5000), renew)
    }

    void grant(null)
    return { close: end }
  }
}
