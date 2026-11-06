import { concat, hmacSha256Hex, timingSafeEqual, utf8 } from './crypto'
import { WebhookSignatureError } from './errors'
import type { AnyDzbotEvent } from './events'

export interface VerifyOptions {
  /** Seconds a delivery may be older or newer than now. Default 300. */
  tolerance?: number
  /** Unix seconds; for tests. */
  now?: number
}

export type RawBody = string | Uint8Array

function bytesOf(body: RawBody): Uint8Array {
  return typeof body === 'string' ? utf8(body) : body
}

function parseHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const index = part.indexOf('=')
    if (index < 1) throw new WebhookSignatureError('bad_format')
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === 't') {
      if (!/^\d+$/.test(value)) throw new WebhookSignatureError('bad_format')
      timestamp = Number(value)
    } else if (key === 'v1') {
      signatures.push(value.toLowerCase())
    }
  }
  if (timestamp === null || signatures.length === 0) throw new WebhookSignatureError('bad_format')
  return { timestamp, signatures }
}

/**
 * Checks a delivery's `dzbot-signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Pass the body exactly as received — parsed and re-serialised JSON no longer matches. Throws
 * {@link WebhookSignatureError}; the signature is checked before the time.
 */
export async function verifyWebhook(rawBody: RawBody, signatureHeader: string | null | undefined, secret: string, options: VerifyOptions = {}): Promise<void> {
  if (!signatureHeader || !signatureHeader.trim()) throw new WebhookSignatureError('missing_header')
  const { timestamp, signatures } = parseHeader(signatureHeader)

  const expected = await hmacSha256Hex(secret, concat(utf8(`${timestamp}.`), bytesOf(rawBody)))
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) throw new WebhookSignatureError('no_match')

  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (options.tolerance ?? 300)) throw new WebhookSignatureError('timestamp_out_of_range')
}

/** Verifies a delivery and returns its event. */
export async function parseEvent(rawBody: RawBody, signatureHeader: string | null | undefined, secret: string, options: VerifyOptions = {}): Promise<AnyDzbotEvent> {
  await verifyWebhook(rawBody, signatureHeader, secret, options)
  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody)
  return JSON.parse(text) as AnyDzbotEvent
}

export type WebhookHandler = (event: AnyDzbotEvent) => unknown | Promise<unknown>

/**
 * A Fetch handler (`Request → Response`) for Workers, Deno, Bun, Next.js route handlers and the like:
 * `400` on a bad signature, `200` once `handler` resolved, `500` when it threw (dzbot then retries).
 */
export function webhookHandler(secret: string, handler: WebhookHandler, options: VerifyOptions = {}): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = new Uint8Array(await request.arrayBuffer())
    let event: AnyDzbotEvent
    try {
      event = await parseEvent(body, request.headers.get('dzbot-signature'), secret, options)
    } catch (e) {
      return new Response(e instanceof WebhookSignatureError ? e.code : 'bad request', { status: 400 })
    }
    try {
      await handler(event)
    } catch {
      return new Response('handler failed', { status: 500 })
    }
    return new Response('ok', { status: 200 })
  }
}

interface ExpressLikeRequest {
  body?: unknown
  headers: Record<string, string | string[] | undefined>
}

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse
  send(body?: unknown): unknown
}

/**
 * Express middleware. Mount it with the raw body, before any JSON parser:
 * `app.post('/webhooks/dzbot', express.raw({ type: 'application/json' }), expressWebhook(secret, handler))`.
 */
export function expressWebhook(secret: string, handler: WebhookHandler, options: VerifyOptions = {}): (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<void> {
  return async (req, res) => {
    const body = req.body
    if (!(body instanceof Uint8Array) && typeof body !== 'string') {
      res.status(500).send('dzbot webhooks need the raw body: mount express.raw({ type: "application/json" }) on this route')
      return
    }
    const header = req.headers['dzbot-signature']
    let event: AnyDzbotEvent
    try {
      event = await parseEvent(body, Array.isArray(header) ? header[0] : header, secret, options)
    } catch (e) {
      res.status(400).send(e instanceof WebhookSignatureError ? e.code : 'bad request')
      return
    }
    try {
      await handler(event)
    } catch {
      res.status(500).send('handler failed')
      return
    }
    res.status(200).send('ok')
  }
}
