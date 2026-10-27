import type { DzbotEventPayloads } from './events.generated'

export type { DzbotEventPayloads } from './events.generated'
export { EVENT_NAMES } from './events.generated'

/** What every webhook delivery and live message carries. */
export interface EventEnvelope<N extends string = string, P = Record<string, unknown>> {
  /** Unique per occurrence: a redelivery has the same id. */
  id: string
  name: N
  organizationId: number
  /** Null for events of the whole organization (reviews, some transactions). */
  serverId: number | null
  /** RFC 3339, UTC. */
  occurredAt: string
  payload: P
}

export type EventName = keyof DzbotEventPayloads & string

export type DzbotEvent<N extends EventName = EventName> = { [K in N]: EventEnvelope<K, DzbotEventPayloads[K]> }[N]

/** An event the SDK has no type for yet (newer than this version). */
export type UnknownDzbotEvent = EventEnvelope<string, Record<string, unknown>>

export type AnyDzbotEvent = DzbotEvent | UnknownDzbotEvent

/** Narrows an event to one name with its typed payload: `if (isEvent(event, 'log.player_kill')) event.payload.data.weapon`. */
export function isEvent<N extends EventName>(event: AnyDzbotEvent, name: N): event is DzbotEvent<N> {
  return event.name === name
}
