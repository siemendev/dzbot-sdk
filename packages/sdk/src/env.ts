export const SDK_VERSION = '0.1.0'

export const DEFAULT_API_URL = 'https://api.dzbot.de'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
