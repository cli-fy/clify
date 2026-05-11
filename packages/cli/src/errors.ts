const clifyErrorCodes = [
  'UNKNOWN_COMMAND',
  'INVALID_SOURCE_SPEC',
  'LOCAL_NOT_MANAGED',
  'INSTALL_FAILED',
  'INSTALL_TIMEOUT',
  'REF_NOT_FOUND',
  'INVALID_PLUGIN',
  'PLUGIN_LOAD_ERROR',
  'PLUGIN_NOT_INSTALLED',
  'DIR_NOT_EMPTY',
] as const

type ClifyErrorCode = (typeof clifyErrorCodes)[number]

export class ClifyError extends Error {
  readonly code: ClifyErrorCode

  constructor(code: ClifyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClifyError'
    this.code = code
  }
}

export function isClifyError(error: unknown): error is ClifyError {
  return error instanceof ClifyError
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

export function nodeErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null
  return typeof error.code === 'string' ? error.code : null
}
