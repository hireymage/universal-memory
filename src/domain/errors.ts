export type ErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'READ_ONLY' | 'AUTH_REQUIRED' | 'PATH_ESCAPE' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'INVALID_SOURCE_TYPE';

export class MemoryError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'MemoryError';
  }
}
