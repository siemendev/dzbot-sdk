import type { EventSourceLike } from './live'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

/**
 * A server-sent event stream read with `fetch`, so the token travels in the `Authorization` header: the event hub
 * refuses tokens in the URL, and `EventSource` cannot send headers. Unlike `EventSource` it never reconnects by
 * itself — every error closes it, and the caller decides when to open the next one.
 */
export function openEventStream(url: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): EventSourceLike {
  const abort = new AbortController()
  const stream: EventSourceLike & { readyState: number } = {
    readyState: CONNECTING,
    onopen: null,
    onmessage: null,
    onerror: null,
    close() {
      stream.readyState = CLOSED
      abort.abort()
    },
  }

  const fail = (error: unknown) => {
    if (stream.readyState === CLOSED) return
    stream.close()
    stream.onerror?.(error)
  }

  void (async () => {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: abort.signal,
    })
    if (!response.ok || !response.body) throw new Error(`The event hub answered ${response.status}`)
    if (stream.readyState === CLOSED) return
    stream.readyState = OPEN
    stream.onopen?.({})

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let data: string[] = []
    let type = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split(/\r\n|\r|\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0 && (type === '' || type === 'message')) stream.onmessage?.({ data: data.join('\n') })
          data = []
          type = ''
          continue
        }
        const colon = line.indexOf(':')
        if (colon === 0) continue
        const field = colon < 0 ? line : line.slice(0, colon)
        const fieldValue = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(fieldValue)
        else if (field === 'event') type = fieldValue
      }
    }
    throw new Error('The event hub ended the stream')
  })().catch(fail)

  return stream
}
