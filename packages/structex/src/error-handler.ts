import type { ErrorRequestHandler, Request } from "express";
import { isHttpError } from "./errors.js";

export interface ErrorHandlerOptions {
  /**
   * Include stack traces in 5xx responses. Defaults to false — leaking a
   * stack trace to a client is an information disclosure, not a convenience.
   */
  exposeStack?: boolean;
  /** Where to log 5xx errors. Pass `() => {}` to silence. */
  log?: (err: unknown, req: Request) => void;
  /** Body sent for unhandled 5xx errors. */
  message?: string;
  /** Reshape the response body, e.g. to match an existing envelope. */
  format?: (
    body: { message: string; details?: unknown },
    context: { status: number; err: unknown; req: Request },
  ) => unknown;
}

/**
 * Builds the error handler to mount after your routes.
 *
 * Structex forwards every thrown error to `next(err)`, so this is the single
 * place statuses are decided. `HttpError`s keep their status and message;
 * anything else becomes a generic 500 so internal messages never reach a
 * client by accident.
 *
 * ```ts
 * app.use(createErrorHandler());
 * ```
 */
/**
 * Reads a status from an error the way the Express ecosystem sets one.
 *
 * `http-errors`, Express's own 404s, and a lot of hand-rolled middleware all
 * attach `status` or `statusCode`. Ignoring those would turn a deliberate 404
 * from existing middleware into a 500.
 */
function statusOf(err: unknown): number {
  if (isHttpError(err)) return err.status;

  const candidate = err as { status?: unknown; statusCode?: unknown };
  for (const value of [candidate?.status, candidate?.statusCode]) {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 400 &&
      value <= 599
    ) {
      return value;
    }
  }
  return 500;
}

/**
 * Whether the error's own message is safe to send.
 *
 * `HttpError` and 4xx messages are written for clients. `http-errors` marks
 * this explicitly with `expose`, so honour that when present.
 */
function shouldExposeMessage(err: unknown, status: number): boolean {
  const expose = (err as { expose?: unknown })?.expose;
  if (typeof expose === "boolean") return expose;
  return status < 500;
}

export function createErrorHandler(
  options: ErrorHandlerOptions = {},
): ErrorRequestHandler {
  const {
    exposeStack = false,
    log = (err) => console.error(err),
    message = "Internal server error",
    format,
  } = options;

  return (err, req, res, next) => {
    // Express requires delegating once headers are out, or the response
    // is corrupted mid-flight.
    if (res.headersSent) {
      next(err);
      return;
    }

    const status = statusOf(err);

    if (status >= 500) log(err, req);

    const exposed = shouldExposeMessage(err, status);
    const body: { message: string; details?: unknown; stack?: string } = {
      message:
        exposed && (err as Error)?.message ? (err as Error).message : message,
    };

    if (isHttpError(err) && err.details !== undefined) {
      body.details = err.details;
    }
    if (exposeStack && status >= 500 && err instanceof Error) {
      body.stack = err.stack;
    }

    res.status(status).json(format ? format(body, { status, err, req }) : body);
  };
}
