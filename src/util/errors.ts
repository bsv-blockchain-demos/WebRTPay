/** Machine-readable reason carried by every {@link WebRTPayError}. */
export type WebRTPayErrorCode =
  | 'timeout'
  | 'closed'
  | 'protocol'
  | 'auth_failed'
  | 'peer_unreachable'
  | 'rejected'
  | 'invalid_code'
  | 'invalid_payment'
  | 'invalid_signal'
  | 'rate_limited'
  | 'too_large'
  | 'unsupported'

/**
 * The only error type this package throws or rejects with for expected failures
 * (hostile input, timeouts, closed peers). Callers branch on {@link code}.
 */
export class WebRTPayError extends Error {
  readonly code: WebRTPayErrorCode

  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable detail; defaults to the code.
   * @param options - `cause` is the underlying error, kept on `error.cause`.
   */
  constructor(code: WebRTPayErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options && 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'WebRTPayError'
    this.code = code
  }
}
