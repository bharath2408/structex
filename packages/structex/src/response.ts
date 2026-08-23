/** Internal marker. Not exported from the package root. */
export const RESPONSE_ENVELOPE = Symbol.for("structex.response");

export interface ResponseEnvelope<T> {
  readonly [RESPONSE_ENVELOPE]: true;
  readonly body: T;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

export interface RespondInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Returns a body with a per-request status and/or headers, so a handler can
 * vary its status without reaching for `@Res()`.
 *
 * ```ts
 * @Put("/:id")
 * upsert(@Param("id") id: string, @Body() dto: Dto) {
 *   const { record, created } = this.repo.upsert(id, dto);
 *   return respond(record, { status: created ? 201 : 200 });
 * }
 * ```
 *
 * A `@HttpCode` on the same handler is overridden by the envelope.
 */
export function respond<T>(body: T, init: RespondInit = {}): ResponseEnvelope<T> {
  return {
    [RESPONSE_ENVELOPE]: true,
    body,
    status: init.status,
    headers: init.headers,
  };
}

export function isResponseEnvelope(
  value: unknown,
): value is ResponseEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RESPONSE_ENVELOPE] === true
  );
}

/** Returned from a `@Redirect` handler to override the decorator's target. */
export interface RedirectResult {
  url: string;
  status?: number;
}

export function isRedirectResult(value: unknown): value is RedirectResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RedirectResult).url === "string"
  );
}

/** A single server-sent event. */
export interface SseEvent<T = unknown> {
  data: T;
  /** Event name; consumed by `addEventListener(name)` on the client. */
  event?: string;
  id?: string;
  /** Client reconnect delay in milliseconds. */
  retry?: number;
}

/** What an `@Sse` handler may return. */
export type SseStream<T = unknown> =
  | AsyncIterable<SseEvent<T> | T>
  | Iterable<SseEvent<T> | T>;

export function isSseEvent(value: unknown): value is SseEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in (value as Record<string, unknown>)
  );
}

/** Serializes one event into the `text/event-stream` wire format. */
export function formatSseEvent(input: unknown): string {
  const event: SseEvent = isSseEvent(input) ? input : { data: input };
  const lines: string[] = [];

  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);

  const payload =
    typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  // Multi-line payloads need one `data:` per line.
  for (const line of String(payload ?? "").split("\n")) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}
