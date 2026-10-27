import { pkceChallenge, pkceVerifier, base64url, randomBytes } from './crypto'
import { OAuthError, errorFromResponse } from './errors'
import { DEFAULT_API_URL, isBrowser, type FetchLike } from './env'

/** Where the SDK keeps tokens and the pending sign-in. One store per signed-in user. */
export interface TokenStore {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
}

export class MemoryTokenStore implements TokenStore {
  private readonly values = new Map<string, string>()

  get(key: string): string | null {
    return this.values.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.values.set(key, value)
  }

  remove(key: string): void {
    this.values.delete(key)
  }
}

export class SessionStorageTokenStore implements TokenStore {
  get(key: string): string | null {
    return globalThis.sessionStorage.getItem(key)
  }

  set(key: string, value: string): void {
    globalThis.sessionStorage.setItem(key, value)
  }

  remove(key: string): void {
    globalThis.sessionStorage.removeItem(key)
  }
}

export interface Tokens {
  accessToken: string
  refreshToken: string | null
  /** Milliseconds since the epoch. */
  expiresAt: number
  scope: string[]
}

export interface OAuthClientOptions {
  clientId: string
  /** Only for confidential clients running on a server. Without it the client is public and relies on PKCE alone. */
  clientSecret?: string
  redirectUri: string
  /** The subdomain of the dzbot server the user signs in on. */
  server: string
  store?: TokenStore
  /** Defaults to https://api.dzbot.de */
  baseUrl?: string
  /** Where the server's website lives; defaults to https://<server>.dzbot.de */
  siteUrl?: string
  fetch?: FetchLike
}

interface PendingSignIn {
  state: string
  verifier: string
}

/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 60_000

/** "Sign in with dzbot": authorization code with PKCE, refresh and revoke. */
export class OAuthClient {
  readonly clientId: string
  readonly server: string
  private readonly clientSecret: string | undefined
  private readonly redirectUri: string
  private readonly store: TokenStore
  private readonly baseUrl: string
  private readonly siteUrl: string
  private readonly fetchImpl: FetchLike
  private refreshing: Promise<Tokens> | null = null

  constructor(options: OAuthClientOptions) {
    if (options.clientSecret && isBrowser()) {
      throw new Error('A client secret must never reach a browser. Use a public client (no clientSecret) there.')
    }
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.redirectUri = options.redirectUri
    this.server = options.server
    this.store = options.store ?? (isBrowser() && globalThis.sessionStorage ? new SessionStorageTokenStore() : new MemoryTokenStore())
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.siteUrl = (options.siteUrl ?? `https://${options.server}.dzbot.de`).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  get confidential(): boolean {
    return this.clientSecret !== undefined
  }

  private key(suffix = ''): string {
    return `dzbot:${this.clientId}:${this.server}${suffix}`
  }

  /** The URL to send the user to. `scope` are access-right keys (wildcards allowed); empty asks for identity only. */
  async authorizeUrl(options: { scope?: string[]; state?: string } = {}): Promise<string> {
    const verifier = pkceVerifier()
    const state = options.state ?? base64url(randomBytes(16))
    const pending: PendingSignIn = { state, verifier }
    await this.store.set(this.key(':pending'), JSON.stringify(pending))

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: (options.scope ?? []).join(' '),
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })
    return `${this.siteUrl}/oauth/authorize?${params.toString()}`
  }

  /** Finishes the sign-in on the redirect URI: checks `state`, exchanges the code and stores the tokens. */
  async handleCallback(url: string | URL): Promise<Tokens> {
    const params = new URL(url.toString(), 'http://callback.invalid').searchParams
    const error = params.get('error')
    if (error) throw new OAuthError(error, params.get('error_description') ?? error)

    const raw = await this.store.get(this.key(':pending'))
    const pending = raw ? (JSON.parse(raw) as PendingSignIn) : null
    if (!pending || pending.state !== params.get('state')) {
      throw new OAuthError('state_mismatch', 'The sign-in was not started here or has already been finished.')
    }
    const code = params.get('code')
    if (!code) throw new OAuthError('missing_code', 'The redirect carries no code.')

    await this.store.remove(this.key(':pending'))
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    })
  }

  async tokens(): Promise<Tokens | null> {
    const raw = await this.store.get(this.key())
    return raw ? (JSON.parse(raw) as Tokens) : null
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.tokens()) !== null
  }

  /** A valid access token, refreshed when it expires within a minute. */
  async accessToken(): Promise<string> {
    const tokens = await this.tokens()
    if (!tokens) throw new OAuthError('login_required', 'Nobody is signed in.')
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken
    return (await this.refresh()).accessToken
  }

  /** Refreshes the tokens. Concurrent callers share one request; a failure signs the user out. */
  refresh(): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<Tokens> {
    const tokens = await this.tokens()
    if (!tokens?.refreshToken) {
      await this.store.remove(this.key())
      throw new OAuthError('login_required', 'The session has ended; sign in again.')
    }
    try {
      return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
    } catch (e) {
      await this.store.remove(this.key())
      throw new OAuthError('login_required', e instanceof Error ? e.message : 'The session has ended; sign in again.')
    }
  }

  /** Revokes the refresh token at dzbot and forgets the tokens. */
  async revoke(): Promise<void> {
    const tokens = await this.tokens()
    await this.store.remove(this.key())
    const token = tokens?.refreshToken ?? tokens?.accessToken
    if (!token) return
    await this.fetchImpl(`${this.baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(this.withClient({ token })).toString(),
    }).catch(() => undefined)
  }

  private withClient(params: Record<string, string>): Record<string, string> {
    return { ...params, client_id: this.clientId, ...(this.clientSecret !== undefined ? { client_secret: this.clientSecret } : {}) }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Tokens> {
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(this.withClient(params)).toString(),
    })
    if (!response.ok) {
      const error = await errorFromResponse(response)
      throw new OAuthError(error.code, error.message)
    }
    const body = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
    const tokens: Tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: Date.now() + body.expires_in * 1000,
      // The grant's server travels as a `server:<id>` scope; it is no right.
      scope: body.scope ? body.scope.split(' ').filter((scope) => scope && !scope.startsWith('server:')) : [],
    }
    await this.store.set(this.key(), JSON.stringify(tokens))
    return tokens
  }
}
