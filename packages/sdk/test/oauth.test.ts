import { describe, expect, it } from 'vitest'
import { pkceChallenge } from '../src/crypto'
import { OAuthClient, MemoryTokenStore } from '../src/oauth'

describe('PKCE', () => {
  it('matches the RFC 7636 example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('OAuthClient', () => {
  it('builds the authorize URL on the server website and finishes the sign-in', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const fetch = async (url: string, init: RequestInit = {}) => {
      requests.push({ url, body: String(init.body) })
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'player.shop.access' }), { status: 200 })
    }
    const store = new MemoryTokenStore()
    const oauth = new OAuthClient({ clientId: 'app1', clientSecret: 'secret', redirectUri: 'https://bot.example/cb', server: 'chernarus', store, fetch })

    const url = new URL(await oauth.authorizeUrl({ scope: ['player.shop.*', 'admin.tickets.view'], state: 'xyz' }))
    expect(url.origin + url.pathname).toBe('https://chernarus.dzbot.de/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('player.shop.* admin.tickets.view')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await expect(oauth.handleCallback('https://bot.example/cb?code=c&state=other')).rejects.toMatchObject({ code: 'state_mismatch' })
    const tokens = await oauth.handleCallback('https://bot.example/cb?code=c&state=xyz')
    expect(tokens.scope).toEqual(['player.shop.access'])
    expect(requests[0].url).toBe('https://api.dzbot.de/oauth/token')
    const body = new URLSearchParams(requests[0].body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_secret')).toBe('secret')
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await oauth.accessToken()).toBe('at')
  })

  it('passes a refused consent on as an error', async () => {
    const oauth = new OAuthClient({ clientId: 'app1', redirectUri: 'https://bot.example/cb', server: 's' })
    await expect(oauth.handleCallback('https://bot.example/cb?error=access_denied')).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('signs out when the refresh is refused', async () => {
    const store = new MemoryTokenStore()
    store.set('dzbot:app1:s', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: [] }))
    const fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    const oauth = new OAuthClient({ clientId: 'app1', redirectUri: 'https://bot.example/cb', server: 's', store, fetch })
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: 'login_required' })
    expect(await oauth.isSignedIn()).toBe(false)
  })
})
