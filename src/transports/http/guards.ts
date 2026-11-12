import { timingSafeEqual } from 'node:crypto';
import { MemoryError } from '../../domain/errors.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function loopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Hostname only, with IPv6 addresses in the bracket form the MCP SDK expects. */
export function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const host = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`).hostname;
    return host.includes(':') ? `[${host}]` : host;
  } catch {
    return trimmed;
  }
}

/**
 * Host and Origin allow-lists passed to `createMcpExpressApp`.
 * Loopback binds keep the SDK's automatic localhost checks unless the operator
 * adds names. That is the DNS-rebinding boundary for a server with no token.
 *
 * A non-loopback bind already requires a bearer token. Host is not forced to
 * localhost: a LAN client sends Host as its IP, and an attacker who can set
 * Host can send `localhost` anyway. Browser requests still carry Origin, which
 * must be localhost or `allowed_origins`. Set `http.allowed_hosts` to also
 * restrict Host. `MEMORY_HTTP_ALLOW_ANY_HOST=1` turns both checks off.
 */
export function httpGuardLists(
  bind: string,
  allowedHosts: string[],
  allowedOrigins: string[],
  env: NodeJS.ProcessEnv = process.env,
): { allowedHosts?: string[]; allowedOrigins?: string[] } {
  const extraHosts = unique(allowedHosts.map(hostnameOf));
  const originHosts = unique(allowedOrigins.map(hostnameOf));
  if (loopbackBind(bind)) {
    return {
      ...(extraHosts.length ? { allowedHosts: unique([...LOCAL_HOSTS, ...extraHosts]) } : {}),
      ...(originHosts.length ? { allowedOrigins: unique([...LOCAL_HOSTS, ...originHosts]) } : {}),
    };
  }
  if (truthy(env.MEMORY_HTTP_ALLOW_ANY_HOST)) {
    return originHosts.length ? { allowedOrigins: originHosts } : {};
  }
  return {
    ...(extraHosts.length ? { allowedHosts: unique([...LOCAL_HOSTS, ...extraHosts]) } : {}),
    allowedOrigins: unique([...LOCAL_HOSTS, ...originHosts]),
  };
}

/** Requests per minute for expensive REST routes. `0` or `off` disables the gate. */
export function requestsPerMinute(env: string | undefined = process.env.MEMORY_HTTP_RATE_LIMIT): number | null {
  const raw = env?.trim().toLowerCase();
  if (!raw) return 6;
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`MEMORY_HTTP_RATE_LIMIT must be a positive integer, or 0 to disable (got ${JSON.stringify(env)})`);
  }
  return value;
}

export function createRateGate(limit: number | null, windowMs = 60_000): () => void {
  const hits: number[] = [];
  return () => {
    if (limit == null) return;
    const now = Date.now();
    while (hits.length && now - hits[0]! >= windowMs) hits.shift();
    if (hits.length >= limit) throw new MemoryError('RATE_LIMITED', 'Too many requests');
    hits.push(now);
  };
}

export function httpStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'READ_ONLY': return 403;
    case 'AUTH_REQUIRED': return 401;
    case 'RATE_LIMITED': return 429;
    default: return 400;
  }
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const value = typeof record.status === 'number' ? record.status : record.statusCode;
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}

/** MemoryError text is safe to return. Parser limits get a fixed message. Everything else stays on stderr. */
export function publicHttpError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof MemoryError) return { status: httpStatus(error.code), code: error.code, message: error.message };
  const status = numericStatus(error);
  if (status === 413) return { status: 413, code: 'VALIDATION_ERROR', message: 'Request body is too large' };
  if (status === 400) return { status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be JSON' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' };
}
