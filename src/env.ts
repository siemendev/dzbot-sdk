export const SDK_VERSION = '0.3.1'

export const DEFAULT_API_URL = 'https://api.dzbot.de'

export function withoutTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
