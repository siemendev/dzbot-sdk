import { describe, expect, it } from 'vitest'
import raw from './vectors/webhook-signature.json?raw'
import { WebhookSignatureError } from '../src/errors'
import { isEvent } from '../src/events'
import { expressWebhook, parseEvent, verifyWebhook, webhookHandler } from '../src/webhooks'

interface Vector {
  description: string
  secret: string
  timestamp: number
  now: number
  body: string
  header: string
  valid: boolean
  error?: string
}

const { cases } = JSON.parse(raw) as { cases: Vector[] }
const valid = cases[0]

describe('verifyWebhook against the shared vectors', () => {
  for (const vector of cases) {
    it(vector.description, async () => {
      const result = verifyWebhook(vector.body, vector.header, vector.secret, { now: vector.now })
      if (vector.valid) {
        await expect(result).resolves.toBeUndefined()
      } else {
        await expect(result).rejects.toMatchObject({ name: 'WebhookSignatureError', code: vector.error })
      }
    })
  }

  it('accepts the body as bytes', async () => {
    await expect(verifyWebhook(new TextEncoder().encode(valid.body), valid.header, valid.secret, { now: valid.now })).resolves.toBeUndefined()
  })
})

describe('parseEvent', () => {
  it('returns the typed envelope', async () => {
    const event = await parseEvent(valid.body, valid.header, valid.secret, { now: valid.now })
    expect(isEvent(event, 'order.created')).toBe(true)
    if (isEvent(event, 'order.created')) {
      expect(event.payload.order.code).toBe('7KQM')
    }
  })
})

describe('webhookHandler', () => {
  const request = (header: string, body = valid.body) =>
    new Request('https://bot.example/webhooks', { method: 'POST', headers: { 'dzbot-signature': header }, body })

  it('answers 200 after the handler and 400 on a bad signature', async () => {
    const seen: string[] = []
    const handle = webhookHandler(valid.secret, (event) => void seen.push(event.name), { now: valid.now })
    expect((await handle(request(valid.header))).status).toBe(200)
    expect(seen).toEqual(['order.created'])
    const rejected = await handle(request(cases.find((c) => c.error === 'no_match')!.header))
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('no_match')
  })

  it('answers 500 when the handler throws, so dzbot retries', async () => {
    const handle = webhookHandler(valid.secret, () => { throw new Error('db down') }, { now: valid.now })
    expect((await handle(request(valid.header))).status).toBe(500)
  })
})

describe('expressWebhook', () => {
  function response() {
    const res = { code: 0, body: undefined as unknown, status(code: number) { res.code = code; return res }, send(body?: unknown) { res.body = body } }
    return res
  }

  it('verifies a raw body', async () => {
    const res = response()
    await expressWebhook(valid.secret, () => undefined, { now: valid.now })({ body: new TextEncoder().encode(valid.body), headers: { 'dzbot-signature': valid.header } }, res)
    expect(res.code).toBe(200)
  })

  it('explains a parsed body instead of failing every signature', async () => {
    const res = response()
    await expressWebhook(valid.secret, () => undefined)({ body: JSON.parse(valid.body), headers: { 'dzbot-signature': valid.header } }, res)
    expect(res.code).toBe(500)
    expect(String(res.body)).toContain('express.raw')
  })
})

it('names the failure in the error', () => {
  expect(new WebhookSignatureError('no_match').message).toContain('no_match')
})
