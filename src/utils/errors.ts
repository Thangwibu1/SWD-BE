/**
 * Standard error envelope used by the evaluator API and every SUT role:
 * { code, message, details, requestId }.
 */
export interface ErrorEnvelope {
  code: string;
  message: string;
  details: unknown;
  requestId: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toEnvelope(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorEnvelope } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, details: error.details, requestId },
    };
  }
  // Body-parser errors carry a status/type; surface them as client errors.
  if (typeof error === 'object' && error !== null && 'type' in error && 'status' in error) {
    const status = Number((error as { status: unknown }).status);
    if (status >= 400 && status < 500) {
      const type = String((error as { type: unknown }).type);
      const code = type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST_BODY';
      return {
        status,
        body: { code, message: 'Request body rejected', details: { type }, requestId },
      };
    }
  }
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', details: null, requestId },
  };
}
