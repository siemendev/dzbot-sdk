import { describe, expect, it } from 'vitest'
import { Dzbot } from '../src/client'
import { PermissionError, RateLimitError } from '../src/errors'
import { OAuthClient, MemoryTokenStore } from '../src/oauth'

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request ${url}`)
    return typeof next === 'function' ? next() : next
  }
  return { fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const page = (ids: string[], pageNo: number, total: number) => ({
  type: 'order', view: 'admin', sort: '-created', filters: {}, facets: {}, meta: {},
  items: ids.map((id) => ({ type: 'order', id, code: null, label: `#${id}`, subtitle: null, snippet: null, image: null, path: null, matchLevel: 'primary', exact: false })),
  page: { kind: 'pages', page: pageNo, perPage: 2, total, totalCapped: false },
})

const noSleep = { sleep: async () => undefined }

describe('Dzbot requests', () => {
  it('sends the key, the server and the SDK version', async () => {
    const { fetch, calls } = fakeFetch([json({ kind: 'api_key' })])
    await new Dzbot({ server: 'chernarus', apiKey: 'dzk_test', fetch }).me()
    const headers = calls[0].init.headers as Record<string, string>
    expect(calls[0].url).toBe('https://api.dzbot.de/api/developer/me')
    expect(headers.authorization).toBe('Bearer dzk_test')
    expect(headers['x-server-subdomain']).toBe('chernarus')
    expect(headers['user-agent']).toMatch(/^dzbot-sdk-js\//)
  })

  it('retries a GET on 503 and after Retry-After on 429', async () => {
    const waits: number[] = []
    const { fetch, calls } = fakeFetch([json({ error: 'down' }, 503), json({ error: 'slow_down' }, 429, { 'retry-after': '3' }), json({ ok: true })])
    const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch, sleep: async (ms) => void waits.push(ms) })
    expect(await dzbot.get('/api/x')).toEqual({ ok: true })
    expect(calls).toHaveLength(3)
    expect(waits).toEqual([500, 3000])
  })

  it('gives up after two retries', async () => {
    const { fetch, calls } = fakeFetch([json({}, 502), json({}, 502), json({ error: 'bad_gateway' }, 502)])
    await expect(new Dzbot({ server: 's', apiKey: 'dzk_x', fetch, ...noSleep }).get('/api/x')).rejects.toMatchObject({ status: 502, code: 'bad_gateway' })
    expect(calls).toHaveLength(3)
  })

  it('never retries a write', async () => {
    const { fetch, calls } = fakeFetch([json({ error: 'slow_down' }, 429, { 'retry-after': '1' })])
    await expect(new Dzbot({ server: 's', apiKey: 'dzk_x', fetch, ...noSleep }).post('/api/x', {})).rejects.toBeInstanceOf(RateLimitError)
    expect(calls).toHaveLength(1)
  })

  it('names the missing right', async () => {
    const { fetch } = fakeFetch([json({ error: 'forbidden', right: 'admin.orders.view' }, 403)])
    const error = await new Dzbot({ server: 's', apiKey: 'dzk_x', fetch }).get('/api/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PermissionError)
    expect((error as PermissionError).right).toBe('admin.orders.view')
  })
})

describe('search', () => {
  it('walks every page of a list', async () => {
    const { fetch, calls } = fakeFetch([json(page(['1', '2'], 1, 3)), json(page(['3'], 2, 3))])
    const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch })
    const ids: string[] = []
    for await (const hit of dzbot.search('order', { status: ['pending', 'delivered'], created: '7d' })) ids.push(hit.id)
    expect(ids).toEqual(['1', '2', '3'])
    expect(calls[0].url).toBe('https://api.dzbot.de/api/admin/search/order?status=pending&status=delivered&created=7d')
    expect(calls[1].url).toContain('page=2')
  })

  it('follows a cursor', async () => {
    const cursorPage = (ids: string[], next: string | null) => ({ ...page(ids, 1, 0), page: { kind: 'cursor', perPage: 2, nextCursor: next } })
    const { fetch, calls } = fakeFetch([json(cursorPage(['a', 'b'], 'c1')), json(cursorPage(['c'], null))])
    const ids: string[] = []
    for await (const hit of new Dzbot({ server: 's', apiKey: 'dzk_x', fetch }).search('log_event')) ids.push(hit.id)
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(calls[1].url).toContain('cursor=c1')
  })

  it('finds a player by Discord id only on an exact hit', async () => {
    const hit = { ...page(['42'], 1, 1).items[0], type: 'player', label: 'Survivor', exact: true, fields: { balance: 1200 } }
    const { fetch, calls } = fakeFetch([json({ ...page([], 1, 1), items: [hit] }), json(page(['7'], 1, 1))])
    const dzbot = new Dzbot({ server: 's', apiKey: 'dzk_x', fetch })
    expect(await dzbot.players.findByDiscordId('637704195486515222')).toEqual({ id: 42, name: 'Survivor', balance: 1200, fields: { balance: 1200 } })
    expect(calls[0].url).toBe('https://api.dzbot.de/api/admin/search/player?q=637704195486515222&limit=5')
    expect(await dzbot.players.findByDiscordId('1')).toBeNull()
  })
})

describe('with Sign in with dzbot', () => {
  async function signedIn(expiresIn: number) {
    const store = new MemoryTokenStore()
    store.set('dzbot:app:s', JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + expiresIn, scope: [] }))
    return store
  }

  it('refreshes an expiring token once for concurrent requests', async () => {
    const store = await signedIn(10_000)
    const { fetch, calls } = fakeFetch([
      json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' }),
      json({ n: 1 }),
      json({ n: 2 }),
    ])
    const oauth = new OAuthClient({ clientId: 'app', redirectUri: 'https://bot.example/cb', server: 's', store, fetch })
    const dzbot = new Dzbot({ server: 's', oauth, fetch })
    await Promise.all([dzbot.get('/api/a'), dzbot.get('/api/b')])
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(1)
    expect(calls.slice(1).map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual(['Bearer new', 'Bearer new'])
    expect(String(calls[0].init.body)).toContain('grant_type=refresh_token')
  })

  it('refreshes once on a 401', async () => {
    const store = await signedIn(3_600_000)
    const { fetch, calls } = fakeFetch([
      json({ error: 'invalid_token' }, 401),
      json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }),
      json({ ok: true }),
    ])
    const oauth = new OAuthClient({ clientId: 'app', redirectUri: 'https://bot.example/cb', server: 's', store, fetch })
    expect(await new Dzbot({ server: 's', oauth, fetch }).get('/api/a')).toEqual({ ok: true })
    expect(calls).toHaveLength(3)
  })

  it('uses the shop search for a signed-in player', async () => {
    const store = await signedIn(3_600_000)
    const { fetch, calls } = fakeFetch([json(page([], 1, 0))])
    const oauth = new OAuthClient({ clientId: 'app', redirectUri: 'https://bot.example/cb', server: 's', store, fetch })
    await new Dzbot({ server: 's', oauth, fetch }).searchPage('order')
    expect(calls[0].url).toBe('https://api.dzbot.de/api/search/order')
  })
})
