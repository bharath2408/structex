import { HttpError } from "./errors.js";
import type { ExecutionContext, Interceptor } from "./metadata.js";

/** Logs handler duration. Replace `log` to route into your own logger. */
export function timing(
  log: (line: string, ctx: ExecutionContext) => void = (line) =>
    console.log(line),
): Interceptor {
  return async (ctx, next) => {
    const start = performance.now();
    try {
      return await next();
    } finally {
      const ms = (performance.now() - start).toFixed(1);
      log(`${ctx.method.toUpperCase()} ${ctx.path} ${ms}ms`, ctx);
    }
  };
}

/**
 * Fails the request if the handler exceeds `ms`.
 *
 * Note: this rejects the response but cannot cancel the underlying work —
 * the handler keeps running. Use an AbortSignal in the handler for true
 * cancellation.
 */
export function timeout(ms: number, status = 408): Interceptor {
  return async (_ctx, next) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new HttpError(status, `Request timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export interface CacheOptions {
  /** Time to live in milliseconds. */
  ttl: number;
  /** Maximum number of entries before the oldest is evicted. Default 500. */
  max?: number;
  /** Cache key. Defaults to method + original URL. */
  key?: (ctx: ExecutionContext) => string;
}

/**
 * In-memory response cache with TTL and LRU eviction.
 *
 * Single-process only — it is not shared across workers or instances. Do not
 * use it on routes whose output varies per user unless `key` includes the
 * user identity.
 */
export function cache(options: CacheOptions): Interceptor {
  const {
    ttl,
    max = 500,
    key = (ctx) => `${ctx.method}:${ctx.req.originalUrl}`,
  } = options;

  const entries = new Map<string, { promise: Promise<unknown>; expires: number }>();

  return async (ctx, next) => {
    const cacheKey = key(ctx);
    const hit = entries.get(cacheKey);

    if (hit && hit.expires > Date.now()) {
      entries.delete(cacheKey);
      entries.set(cacheKey, hit); // refresh LRU position
      return hit.promise;
    }
    if (hit) entries.delete(cacheKey);

    // Cache the in-flight promise before awaiting it, so a burst of
    // concurrent requests for the same cold key share one call to `next()`
    // instead of each independently re-running the handler.
    const promise = next();
    const entry = { promise, expires: Date.now() + ttl };
    entries.set(cacheKey, entry);

    try {
      return await promise;
    } catch (err) {
      // A failure isn't cached — the next call should retry, not replay
      // the same rejection until the TTL runs out.
      if (entries.get(cacheKey) === entry) entries.delete(cacheKey);
      throw err;
    } finally {
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
  };
}

export interface RetryOptions {
  attempts: number;
  /** Delay before each retry, in milliseconds. Default 0. */
  delay?: number | ((attempt: number) => number);
  /** Decide whether an error is retryable. Defaults to non-4xx errors. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Retries the handler on failure.
 *
 * Only safe on idempotent handlers — a retried POST can create duplicates.
 */
export function retry(options: RetryOptions): Interceptor {
  const {
    attempts,
    delay = 0,
    shouldRetry = (err) =>
      !(err instanceof HttpError && err.status >= 400 && err.status < 500),
  } = options;

  return async (_ctx, next) => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await next();
      } catch (err) {
        lastError = err;
        if (attempt === attempts || !shouldRetry(err, attempt)) throw err;
        const wait = typeof delay === "function" ? delay(attempt) : delay;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }

    throw lastError;
  };
}

/**
 * Wraps the result in a consistent envelope for these routes only. For an
 * app-wide envelope prefer the `transform` option on `registerControllers`.
 */
export function envelope(
  wrap: (result: unknown, ctx: ExecutionContext) => unknown = (result) => ({
    data: result,
  }),
): Interceptor {
  return async (ctx, next) => {
    const result = await next();
    return result === undefined ? undefined : wrap(result, ctx);
  };
}
