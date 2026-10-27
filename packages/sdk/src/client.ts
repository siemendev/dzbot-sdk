import { Configuration } from '../../../src/api/generated/runtime'
import { DzbotError, RateLimitError, errorFromResponse } from './errors'
import { DEFAULT_API_URL, SDK_VERSION, isBrowser, type FetchLike } from './env'
import { LiveEvents } from './live'
import type { OAuthClient } from './oauth'

export interface DzbotOptions {
  /** The subdomain of the dzbot server (`your-server` for your-server.dzbot.de). */
  server: string
  /** A server API key (`dzk_…`). Secret: only on a server, never in a browser. */
  apiKey?: string
  /** "Sign in with dzbot": the signed-in user's tokens. */
  oauth?: OAuthClient
  /** Defaults to https://api.dzbot.de */
  baseUrl?: string
  fetch?: FetchLike
  /** Appended to the User-Agent, e.g. `my-bot/1.0`. */
  userAgent?: string
  /** For tests: how the client waits between retries. */
  sleep?: (ms: number) => Promise<void>
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>
export type Query = Record<string, QueryValue>

export interface RequestOptions {
  query?: Query
  body?: unknown
  headers?: Record<string, string>
}

export interface Identity {
  kind: 'user' | 'api_key'
  server: { id: number; subdomain: string; name: string }
  user: { id: number; discordId: string | null } | null
  /** `gameId` is the in-game id (Steam64, DayZ id or console id); `mainPlayerId` the main account across alts. */
  player: { id: number; name: string; gameId: string | null; mainPlayerId: number } | null
  /** The player and their device-linked alts on this server. */
  accounts: Array<{ id: number; name: string; gameId: string | null }>
  /** The concrete rights the key or token holds on this server. */
  rights: string[]
  app: { id: number; name: string } | null
}

export interface SearchHit<F = Record<string, unknown>> {
  type: string
  id: string
  code: string | null
  label: string
  subtitle: string | null
  snippet: string | null
  image: string | null
  path: string | null
  matchLevel: string
  exact: boolean
  fields?: F
}

export type SearchPageInfo =
  | { kind: 'pages'; page: number; perPage: number; total: number; totalCapped: boolean }
  | { kind: 'cursor'; perPage: number; nextCursor: string | null }

export interface SearchPage<F = Record<string, unknown>> {
  type: string
  view: string
  items: SearchHit<F>[]
  page: SearchPageInfo
  sort: string
  filters: Record<string, unknown>
  facets: Record<string, Record<string, number>>
  meta: Record<string, unknown>
}

/** Which search door: the admin area (API keys, staff) or what a signed-in player sees. */
export type SearchArea = 'admin' | 'player'

export interface SearchOptions {
  area?: SearchArea
}

const RETRY_STATUSES = new Set([502, 503, 504])
const BACKOFF_MS = [500, 2000]
const MAX_RETRY_AFTER_S = 60

export interface PlayerSummary {
  id: number
  name: string
  balance: number | null
  fields: Record<string, unknown>
}

export interface OrderItem {
  itemSetId: number
  quantity?: number
}

export interface OrderOptions {
  items: OrderItem[]
  /** A saved delivery place of the player. */
  placeId?: number
  /** Or a position in world metres. */
  position?: { x: number; y: number; z: number }
  /** Pay from the player's faction treasury. */
  factionId?: number
}

/** The client: everything goes through `request()`, the helpers below are shortcuts. */
export class Dzbot {
  readonly server: string
  readonly baseUrl: string
  readonly players: Players
  readonly wallet: Wallet
  readonly shop: Shop
  readonly events: LiveEvents
  private readonly apiKey: string | undefined
  private readonly oauth: OAuthClient | undefined
  private readonly fetchImpl: FetchLike
  private readonly userAgent: string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: DzbotOptions) {
    if (!options.server) throw new Error('`server` is required: the subdomain of your dzbot server')
    if (!options.apiKey === !options.oauth) throw new Error('Pass either `apiKey` or `oauth`')
    if (options.apiKey && isBrowser()) {
      throw new Error('API keys are secret; use Sign in with dzbot (OAuthClient) in the browser')
    }
    this.server = options.server
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.oauth = options.oauth
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.userAgent = `dzbot-sdk-js/${SDK_VERSION}${options.userAgent ? ` (+${options.userAgent})` : ''}`
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.players = new Players(this)
    this.wallet = new Wallet(this)
    this.shop = new Shop(this)
    this.events = new LiveEvents(this)
  }

  get usesApiKey(): boolean {
    return this.apiKey !== undefined
  }

  private async token(): Promise<string> {
    return this.apiKey ?? (await this.oauth!.accessToken())
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${await this.token()}`,
      'x-server-subdomain': this.server,
      // Browsers forbid setting User-Agent, and an extra header would need a CORS allowance.
      ...(isBrowser() ? {} : { 'user-agent': this.userAgent }),
      ...extra,
    }
  }

  url(path: string, query?: Query): string {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const params = encodeQuery(query)
    return params ? `${url}?${params}` : url
  }

  /**
   * One API call. Throws {@link DzbotError} (or {@link RateLimitError}, {@link PermissionError}) outside 2xx.
   * GETs are retried on 429 (after Retry-After, at most 60 s) and 502/503/504, twice at most; with a
   * signed-in user a 401 refreshes the token once.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase()
    const hasBody = options.body !== undefined
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(this.url(path, options.query), {
        method: upper,
        headers: await this.headers({ ...(hasBody ? { 'content-type': 'application/json' } : {}), ...options.headers }),
        body: hasBody ? JSON.stringify(options.body) : undefined,
      })
      if (response.ok) {
        if (response.status === 204) return undefined as T
        const text = await response.text()
        return (text ? JSON.parse(text) : undefined) as T
      }
      const error = await errorFromResponse(response)
      if (error.status === 401 && this.oauth && !refreshed && error.code !== 'token_server_mismatch') {
        refreshed = true
        await this.oauth.refresh()
        attempt--
        continue
      }
      if (upper !== 'GET' || attempt >= BACKOFF_MS.length) throw error
      if (error instanceof RateLimitError) {
        if (error.retryAfter > MAX_RETRY_AFTER_S) throw error
        await this.sleep(error.retryAfter * 1000)
      } else if (RETRY_STATUSES.has(error.status)) {
        await this.sleep(BACKOFF_MS[attempt])
      } else {
        throw error
      }
    }
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body })
  }

  /** Who the key or the signed-in user is on this server, and what they may do. */
  me(): Promise<Identity> {
    return this.get<Identity>('/api/developer/me')
  }

  private searchPath(type: string, area: SearchArea | undefined): string {
    const door = (area ?? (this.usesApiKey ? 'admin' : 'player')) === 'admin' ? '/api/admin/search' : '/api/search'
    return `${door}/${encodeURIComponent(type)}`
  }

  /** One page of a list. `filter` takes `q`, the type's filter keys, `sort`, `page`/`cursor` and `limit`. */
  searchPage<F = Record<string, unknown>>(type: string, filter: Query = {}, options: SearchOptions = {}): Promise<SearchPage<F>> {
    return this.get<SearchPage<F>>(this.searchPath(type, options.area), filter)
  }

  /** Every row of a list, page after page: `for await (const order of dzbot.search('order', { status: 'pending' }))`. */
  async *search<F = Record<string, unknown>>(type: string, filter: Query = {}, options: SearchOptions = {}): AsyncGenerator<SearchHit<F>> {
    let query: Query = { ...filter }
    for (;;) {
      const page = await this.searchPage<F>(type, query, options)
      yield* page.items
      if (page.items.length === 0) return
      if (page.page.kind === 'cursor') {
        if (!page.page.nextCursor) return
        query = { ...query, cursor: page.page.nextCursor }
      } else {
        if (page.page.page * page.page.perPage >= page.page.total) return
        query = { ...query, page: page.page.page + 1 }
      }
    }
  }

  /** A configuration for the generated client in `@dzbot/sdk/api` (every endpoint, typed). */
  configuration(): Configuration {
    return new Configuration({
      basePath: this.baseUrl,
      accessToken: () => this.token(),
      headers: { 'X-Server-Subdomain': this.server },
      fetchApi: (input, init) => this.fetchImpl(typeof input === 'string' ? input : input.toString(), init),
    })
  }
}

export function encodeQuery(query: Query | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, String(value))
    }
  }
  return params.toString()
}

function toPlayer(hit: SearchHit): PlayerSummary {
  const fields = hit.fields ?? {}
  const balance = fields.balance
  return { id: Number(hit.id), name: hit.label, balance: typeof balance === 'number' ? balance : null, fields }
}

/** Finding players by what a bot knows about them. Needs the admin player list (`admin.players.view`). */
class Players {
  constructor(private readonly client: Dzbot) {}

  private async findExact(term: string): Promise<PlayerSummary | null> {
    const page = await this.client.searchPage('player', { q: term, limit: 5 }, { area: 'admin' })
    const hit = page.items.find((item) => item.exact)
    return hit ? toPlayer(hit) : null
  }

  /** The player whose dzbot account is linked to this Discord user. */
  findByDiscordId(discordId: string): Promise<PlayerSummary | null> {
    return this.findExact(discordId)
  }

  /** The player with this game id: Steam64, DayZ id, or a console account id. */
  findByGameAccount(id: string): Promise<PlayerSummary | null> {
    return this.findExact(id)
  }
}

/** The organization-wide wallet of a player. Needs `admin.players.change_money`. */
class Wallet {
  constructor(private readonly client: Dzbot) {}

  async credit(playerId: number, amount: number, reason: string): Promise<{ newBalance: number }> {
    return this.client.post(`/api/admin/players/${playerId}/balance`, { operation: 'add', amount, reason })
  }

  async debit(playerId: number, amount: number, reason: string): Promise<{ newBalance: number }> {
    return this.client.post(`/api/admin/players/${playerId}/balance`, { operation: 'remove', amount, reason })
  }
}

/** The shop as the signed-in player sees it. */
class Shop {
  constructor(private readonly client: Dzbot) {}

  /**
   * Places an order for the signed-in player (Sign in with dzbot, `player.shop.checkout`), paid from their
   * balance. Refuses when the player's cart already holds something, so nothing they put there is bought.
   */
  async order(options: OrderOptions): Promise<{ orderId: number; orderCode: string }> {
    if (this.client.usesApiKey) {
      throw new DzbotError(400, 'not_supported', 'Ordering on behalf of a player needs the player signed in (Sign in with dzbot); API keys cannot order yet')
    }
    if (options.items.length === 0) throw new DzbotError(400, 'empty_order', 'An order needs at least one item')
    const cart = await this.client.get<{ items: unknown[] }>('/api/shop/cart')
    if (cart.items.length > 0) throw new DzbotError(409, 'cart_not_empty', 'The player has items in their cart; empty it first')
    for (const item of options.items) {
      await this.client.post(`/api/shop/cart/add/${item.itemSetId}`, { quantity: item.quantity ?? 1 })
    }
    return this.client.post('/api/shop/cart/checkout', {
      placeId: options.placeId ?? null,
      posX: options.position?.x ?? null,
      posY: options.position?.y ?? null,
      posZ: options.position?.z ?? null,
      factionId: options.factionId ?? null,
    })
  }
}
