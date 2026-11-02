import { Configuration } from '../../../src/api/generated/runtime'
import { DzbotError, RateLimitError, errorFromResponse } from './errors'
import { DEFAULT_API_URL, SDK_VERSION, isBrowser, type FetchLike } from './env'
import { LiveEvents } from './live'
import type { OAuthClient } from './oauth'

export interface DzbotOptions {
  /**
   * The subdomain of the dzbot server (`your-server` for your-server.dzbot.de). Required with an API key. With an
   * org-wide sign-in leave it out and pick the server per call with {@link Dzbot.forServer}.
   */
  server?: string
  /** A server API key (`dzk_…`). Secret: only on a server, never in a browser. */
  apiKey?: string
  /** "Sign in with dzbot": the signed-in user's tokens. Without `apiKey` and `oauth` the client reads public data only. */
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

/** A server a sign-in reaches, and the signed-in user's player there. */
export interface MyServer {
  id: number
  subdomain: string
  name: string
  /** The server's colour: amber, teal, cyan, fuchsia, lime or orange. */
  palette: string
  /** The server's website, on its own domain when it has one. */
  url: string
  /** Null where the user has not linked a game account on this server yet. `whitelisted`: on the server's whitelist, whether or not it is on right now. */
  player: { id: number; name: string | null; gameId: string | null; whitelisted: boolean; lastOnline: string | null } | null
}

/** The signed-in player's own profile on a server (`player.shop_profile.access`). */
export interface Profile {
  id: number
  username: string
  displayName: string
  avatarUrl: string | null
  /** The organization-wide wallet: the same on every server of the organization. */
  balance: number
  /** The organization's in-game currency, e.g. "Rubel"; empty when none is set. */
  currency: string
  rulesAccepted: boolean
  hasActiveBanRestriction: boolean
}

/** How full a server is right now; `players` is null when nothing can tell. Public. */
export interface Population {
  players: number | null
  slots: number | null
  queue: number | null
  asOf: string | null
}

/** Whether a server lets only whitelisted players in right now; `changesAt` is when a scheduled task next switches that, if one does. Public. */
export interface WhitelistStatus {
  enabled: boolean
  changesAt: string | null
}

/** The public leaderboards; `most-active` counts minutes online, `longest-kill` metres. */
export type LeaderboardBoard =
  | 'pvp-kills'
  | 'pvp-kd'
  | 'kill-streak'
  | 'longest-kill'
  | 'base-building'
  | 'vehicle-hits'
  | 'most-active'
  | 'casino-net-profit'
  | 'casino-net-loss'
  | 'casino-biggest-win'
  | 'casino-volume'

export type LeaderboardPeriod = 'all_time' | 'month' | 'week'

/** A server's top ten on one board, counted since its last stats wipe. Public where the server shows leaderboards to guests. */
export interface Leaderboard {
  period: LeaderboardPeriod
  currency: string
  entries: Array<{ player: string; playerId: number | null; value: number; hasProfile: boolean }>
  /** K/D boards only rank players with at least this many kills. */
  minimumKills: number
  wipeDate: string
}

export interface Combatant {
  id: number | null
  name: string
  avatarUrl: string | null
  faction: { id: number; name: string; color: string | null } | null
}

/** One line of the kill feed: a kill (`attacker` set) or a death to the environment (`cause` set). */
export interface Kill {
  id: string
  kind: 'kill' | 'environment'
  time: string
  attacker: Combatant | null
  victim: Combatant
  weapon: string | null
  /** Metres. */
  distance: number | null
  cause: string | null
  /** e.g. `team_kill`. */
  flags: string[]
}

export type ServerEventStatus = 'registration_open' | 'registration_closed' | 'running' | 'finished' | 'cancelled'

/** An event of the server — a tournament, a race, a team fight. */
export interface ServerEvent {
  id: number
  code: string | null
  name: string
  description: string | null
  status: ServerEventStatus
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  registrationClosesAt: string | null
  participantCount: number
  entryFee: number
  potAmount: number
  /** The event's page, relative to the server's website. */
  path: string | null
}

/** How many players were online over time, as the public server list records it. */
export interface Activity {
  resolution: '15m' | '1h' | '1d'
  from: string
  to: string
  /** `players` is the average over the step, `peak` its highest count. */
  points: Array<{ at: string; players: number | null; peak: number | null; queuePeak: number | null; slots: number | null }>
}

/** Where a player stands on one board: `rank` is null below the board's minimum. */
export interface Standing {
  value: number
  rank: number | null
  total: number
  aheadValue: number | null
  tenthValue: number | null
  minimumKills: number
  kills: number | null
  pending: boolean
}

/** The signed-in player's statistics on this server since its last stats wipe, their alts included. */
export interface PlayerStats {
  wipeDate: string
  accounts: Array<{ id: number; name: string }>
  personal: {
    deaths: number
    pvp_deaths: number
    death_streak: number
    online_streak: number
    current_kill_streak: number
    last_pvp_kill: string | null
    last_pvp_death: string | null
  }
  /** `stat` is the board in snake case (`pvp_kills`, `most_active`, …); `casino_net` joins the two casino balance boards. */
  boards: Array<{ stat: string; standing: Standing; best: { period: LeaderboardPeriod; rank: number } | null }>
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
  /** Null on a client of an org-wide sign-in that has not picked a server ({@link Dzbot.forServer}). */
  readonly server: string | null
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
  private readonly options: DzbotOptions

  constructor(options: DzbotOptions) {
    if (options.apiKey && options.oauth) throw new Error('Pass either `apiKey` or `oauth`, not both')
    if (!options.server && !options.oauth) throw new Error('`server` is required: the subdomain of your dzbot server')
    if (options.apiKey && isBrowser()) {
      throw new Error('API keys are secret; use Sign in with dzbot (OAuthClient) in the browser')
    }
    this.options = options
    this.server = options.server ?? null
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

  /** The same client on another server of the organization — for an org-wide sign-in, or public reads. */
  forServer(server: string): Dzbot {
    return new Dzbot({ ...this.options, server })
  }

  private async token(): Promise<string | null> {
    return this.apiKey ?? (this.oauth ? await this.oauth.accessToken() : null)
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.token()
    return {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.server ? { 'x-server-subdomain': this.server } : {}),
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

  /** The servers the sign-in reaches (all of the app's servers for an org-wide sign-in) and the user's player on each. */
  async myServers(): Promise<MyServer[]> {
    return (await this.get<{ servers: MyServer[] }>('/api/developer/me/servers')).servers
  }

  /** The signed-in player's own profile on this server, with the organization-wide balance. */
  profile(): Promise<Profile> {
    return this.get<Profile>('/api/shop/profile')
  }

  /** How full this server is right now. Public: works without signing in. */
  population(): Promise<Population> {
    return this.get<Population>('/api/public/population')
  }

  /** Whether this server's whitelist is on right now and when it next switches. Public: works without signing in. */
  whitelist(): Promise<WhitelistStatus> {
    return this.get<WhitelistStatus>('/api/public/whitelist')
  }

  /** One leaderboard of this server. Public where the server shows leaderboards to guests (else a 403). */
  async leaderboard(board: LeaderboardBoard, options: { period?: LeaderboardPeriod } = {}): Promise<Leaderboard> {
    const { period, currency, entries, minimumKills, wipeDate } = await this.get<Leaderboard>(`/api/public/leaderboard/${board}`, { period: options.period })
    return { period, currency, entries, minimumKills, wipeDate }
  }

  /** The newest kills and deaths of this server's kill feed, newest first. Public where the server shows its kill feed to guests (else a 403). */
  async killfeed(options: { limit?: number } = {}): Promise<Kill[]> {
    const page = await this.get<SearchPage<Omit<Kill, 'id'>>>('/api/public/search/combat_event', { limit: options.limit ?? 20 })
    return page.items.map((hit) => ({ ...hit.fields!, id: hit.id }))
  }

  /** Events that are open for registration, about to start or running, soonest first. Public where the server shows events to guests. */
  upcomingEvents(options: { limit?: number } = {}): Promise<ServerEvent[]> {
    return this.serverEvents(['registration_open', 'registration_closed', 'running'], 'start', options.limit)
  }

  /** Finished events, latest first. */
  pastEvents(options: { limit?: number } = {}): Promise<ServerEvent[]> {
    return this.serverEvents(['finished'], '-start', options.limit)
  }

  private async serverEvents(status: ServerEventStatus[], sort: string, limit = 10): Promise<ServerEvent[]> {
    const page = await this.get<SearchPage<Omit<ServerEvent, 'id' | 'code' | 'path'>>>('/api/public/search/event', { status, sort, limit })
    return page.items.map((hit) => ({ ...hit.fields!, id: Number(hit.id), code: hit.code, path: hit.path }))
  }

  /**
   * Players online over time, from the public server list: `15m` steps for up to 7 days (default 1), `1h` for up to
   * 7 (default 7), `1d` for up to 90 (default 30). Public.
   */
  async activity(options: { resolution?: Activity['resolution']; days?: number } = {}): Promise<Activity> {
    if (!this.server) throw new Error('activity() needs a server: use forServer()')
    const { resolution, from, to, points } = await this.get<Activity>(`/api/public/server-list/${encodeURIComponent(this.server)}/activity`, options)
    return { resolution, from, to, points }
  }

  /** The signed-in player's statistics on this server and where they stand on every leaderboard (`player.shop_profile.access`). */
  stats(): Promise<PlayerStats> {
    return this.get<PlayerStats>('/api/shop/profile/stats')
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
      accessToken: async () => (await this.token()) ?? '',
      headers: this.server ? { 'X-Server-Subdomain': this.server } : {},
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
