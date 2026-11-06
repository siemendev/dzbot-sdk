/** Every answer of the API outside 2xx. `code` is the API's `error` field, `requestId` its `x-request-id` header. */
export class DzbotError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null
  readonly body: unknown

  constructor(status: number, code: string, message: string, requestId: string | null = null, body: unknown = null) {
    super(message)
    this.name = 'DzbotError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.body = body
  }
}

/** `429`: wait `retryAfter` seconds before the next request. */
export class RateLimitError extends DzbotError {
  readonly retryAfter: number

  constructor(retryAfter: number, code: string, message: string, requestId: string | null = null, body: unknown = null) {
    super(429, code, message, requestId, body)
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

/** `403`: the key, token or user lacks a right. `right` names it when the API does. */
export class PermissionError extends DzbotError {
  readonly right: string | null

  constructor(right: string | null, code: string, message: string, requestId: string | null = null, body: unknown = null) {
    super(403, code, message, requestId, body)
    this.name = 'PermissionError'
    this.right = right
  }
}

export type OAuthErrorCode = 'login_required' | 'state_mismatch' | 'missing_code' | 'access_denied' | string

/** Sign in with dzbot failed or needs a new sign-in (`login_required`). */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode

  constructor(code: OAuthErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'OAuthError'
    this.code = code
  }
}

export type WebhookSignatureErrorCode = 'missing_header' | 'bad_format' | 'timestamp_out_of_range' | 'no_match'

export class WebhookSignatureError extends Error {
  readonly code: WebhookSignatureErrorCode

  constructor(code: WebhookSignatureErrorCode, message?: string) {
    super(message ?? `Invalid webhook signature: ${code}`)
    this.name = 'WebhookSignatureError'
    this.code = code
  }
}

export async function errorFromResponse(response: Response): Promise<DzbotError> {
  const requestId = response.headers.get('x-request-id')
  let body: unknown = null
  const text = await response.text().catch(() => '')
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = typeof record.error === 'string' ? record.error : `http_${response.status}`
  const message = typeof record.message === 'string' ? record.message : code

  if (response.status === 429) {
    return new RateLimitError(retryAfterSeconds(response.headers.get('retry-after')), code, message, requestId, body)
  }
  if (response.status === 403) {
    const right = typeof record.right === 'string' ? record.right : null
    return new PermissionError(right, code, message, requestId, body)
  }
  return new DzbotError(response.status, code, message, requestId, body)
}

export function retryAfterSeconds(header: string | null): number {
  if (!header) return 1
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const date = Date.parse(header)
  return Number.isNaN(date) ? 1 : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}
