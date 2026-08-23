/**
 * Errors thrown from handlers, guards, or pipes are forwarded to Express via
 * `next(err)`. Use `HttpError` (or the helpers below) so your error handler can
 * read a status off the error instead of defaulting everything to 500.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
    // Keeps the stack pointing at the throw site rather than this constructor.
    Error.captureStackTrace?.(this, HttpError);
  }
}

/** Type guard usable from an Express error handler. */
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export const BadRequest = (message = "Bad Request", details?: unknown) =>
  new HttpError(400, message, details);

export const Unauthorized = (message = "Unauthorized", details?: unknown) =>
  new HttpError(401, message, details);

export const Forbidden = (message = "Forbidden", details?: unknown) =>
  new HttpError(403, message, details);

export const NotFound = (message = "Not Found", details?: unknown) =>
  new HttpError(404, message, details);

export const Conflict = (message = "Conflict", details?: unknown) =>
  new HttpError(409, message, details);

export const UnprocessableEntity = (
  message = "Unprocessable Entity",
  details?: unknown,
) => new HttpError(422, message, details);

export const TooManyRequests = (message = "Too Many Requests", details?: unknown) =>
  new HttpError(429, message, details);

export const InternalServerError = (
  message = "Internal Server Error",
  details?: unknown,
) => new HttpError(500, message, details);
