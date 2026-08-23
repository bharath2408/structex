import type { IRouter, NextFunction, Request, Response } from "express";
import {
  resolveMeta,
  type ControllerMeta,
  type ExecutionContext,
  type Guard,
  type HttpMethod,
  type Interceptor,
  type ParamDefinition,
} from "./metadata.js";
import { HttpError } from "./errors.js";
import {
  formatSseEvent,
  isResponseEnvelope,
  isRedirectResult,
  type SseStream,
} from "./response.js";
import {
  resolveGroups,
  serialize,
  type SerializeGroups,
} from "./serialization.js";

export type Ctor<T = any> = new (...args: any[]) => T;

/** Internal marker for per-request controller factories. */
const SCOPED = Symbol.for("structex.scoped");

export interface ScopedController<T = any> {
  readonly [SCOPED]: true;
  readonly ctor: Ctor<T>;
  readonly factory: (req: Request, res: Response) => T | Promise<T>;
  /**
   * Cleanup run once the response completes. Used by `createApplication` to
   * dispose request-scoped providers.
   */
  readonly dispose?: (req: Request, res: Response) => void | Promise<void>;
}

/**
 * Constructs a fresh controller for every request — the escape hatch for
 * per-request dependencies (a tenant-scoped repository, a request-bound
 * transaction, a correlation-id logger).
 *
 * ```ts
 * registerControllers(app, [
 *   scoped(OrderController, (req) => new OrderController(db.forTenant(req.tenantId))),
 * ]);
 * ```
 *
 * Route metadata is read from `ctor`, so the factory must return an instance
 * of that class. Prefer a plain instance when nothing varies per request —
 * this allocates on every call.
 */
export function scoped<T>(
  ctor: Ctor<T>,
  factory: (req: Request, res: Response) => T | Promise<T>,
  dispose?: (req: Request, res: Response) => void | Promise<void>,
): ScopedController<T> {
  return { [SCOPED]: true, ctor, factory, dispose };
}

function isScoped(input: unknown): input is ScopedController {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<PropertyKey, unknown>)[SCOPED] === true
  );
}

/** A decorated class, an instance of one, or a `scoped()` factory. */
export type ControllerInput = Ctor | object | ScopedController;

export interface RouteInfo {
  method: HttpMethod;
  path: string;
  controller: string;
  handler: string;
  sse: boolean;
}

/** Passed to the `transform` hook. */
export interface TransformContext extends ExecutionContext {
  status: number;
}

export interface RegisterOptions {
  /** Prepended to every controller prefix, e.g. `"/api/v1"`. */
  prefix?: string;
  /**
   * Success status when a handler returns a value and no `@HttpCode` or
   * `respond()` status is set. Defaults to 201 for POST, 200 otherwise.
   */
  defaultStatus?: (method: HttpMethod) => number;
  /**
   * Shapes every successful JSON body app-wide — the place to add an envelope.
   * Not applied to redirects, SSE streams, empty-body statuses, or responses
   * written directly through `@Res()`.
   *
   * ```ts
   * transform: (result, ctx) => ({ data: result, requestId: ctx.req.id })
   * ```
   */
  transform?: (result: unknown, ctx: TransformContext) => unknown;
  /**
   * Throw when the same controller + handler + method + path is registered
   * twice on one router. Default `true`.
   */
  detectDuplicates?: boolean;
  /** Guards applied to every route, before controller and method guards. */
  guards?: Guard[];
  /** Interceptors applied to every route, outside all others. */
  interceptors?: Interceptor[];
  /**
   * Applies `@Exclude` / `@Expose` / `@Transform` rules to responses.
   * Enabled by default and a no-op until a field is decorated; pass `false`
   * to turn it off entirely.
   */
  serialize?: boolean | { groups?: SerializeGroups };
}

const defaultStatusFor = (method: HttpMethod): number =>
  method === "post" ? 201 : 200;

/** Statuses that must not carry a response body. */
const EMPTY_BODY_STATUSES = new Set([204, 304]);

/** Joins segments and collapses duplicate slashes; always returns a leading `/`. */
export function joinPaths(...segments: string[]): string {
  const joined = segments.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
  if (!joined) return "/";
  const withLeading = joined.startsWith("/") ? joined : `/${joined}`;
  return withLeading.length > 1 ? withLeading.replace(/\/$/, "") : withLeading;
}

function ctorOf(input: ControllerInput): Function {
  if (isScoped(input)) return input.ctor;
  return typeof input === "function" ? input : (input as object).constructor;
}

function metaOf(input: ControllerInput): ControllerMeta | undefined {
  return resolveMeta(ctorOf(input));
}

/** Registration keys already mounted, per router, for duplicate detection. */
const mounted = new WeakMap<object, Set<string>>();

async function resolveArgs(
  params: ParamDefinition[],
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<unknown[]> {
  const args: unknown[] = new Array(
    params.length ? params[params.length - 1]!.index + 1 : 0,
  );
  for (const param of params) {
    let value = param.resolve(req, res, next);
    for (const pipe of param.pipes) value = await pipe(value, param.meta);
    args[param.index] = value;
  }
  return args;
}

/**
 * Runs interceptors outermost-first around `invoke`.
 *
 * `next()` may be called more than once — that is what makes `retry()`
 * possible — so each call re-runs the rest of the chain, including parameter
 * resolution and the handler. Handlers under a re-invoking interceptor must
 * therefore be idempotent.
 */
function runInterceptors(
  interceptors: Interceptor[],
  ctx: ExecutionContext,
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  const dispatch = async (index: number): Promise<unknown> => {
    const interceptor = interceptors[index];
    if (!interceptor) return invoke();
    return interceptor(ctx, () => dispatch(index + 1));
  };

  return dispatch(0);
}

async function streamSse(
  res: Response,
  req: Request,
  stream: SseStream,
): Promise<void> {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on("close", onClose);

  try {
    for await (const event of stream as AsyncIterable<unknown>) {
      if (closed || res.writableEnded) break;
      res.write(formatSseEvent(event));
    }
  } finally {
    req.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * Mounts every decorated route from `controllers` onto an Express app or router.
 *
 * Accepts classes, instances (for constructor injection), or `scoped()`
 * factories (for per-request instances).
 *
 * @returns the routes that were mounted, in registration order.
 */
export function registerControllers(
  app: IRouter,
  controllers: ControllerInput[],
  options: RegisterOptions = {},
): RouteInfo[] {
  const {
    prefix: globalPrefix = "",
    defaultStatus = defaultStatusFor,
    transform,
    detectDuplicates = true,
    guards: globalGuards = [],
    interceptors: globalInterceptors = [],
    serialize: serializeOption = true,
  } = options;

  const serializeEnabled = serializeOption !== false;
  const serializeGroups =
    typeof serializeOption === "object" ? serializeOption.groups : undefined;

  const registered: RouteInfo[] = [];
  let seen = mounted.get(app);
  if (!seen) {
    seen = new Set<string>();
    mounted.set(app, seen);
  }

  for (const input of controllers) {
    const meta = metaOf(input);
    if (!meta) continue; // not a decorated controller

    const controllerName = ctorOf(input).name;

    // Resolves the controller instance for a request.
    const getInstance: (req: Request, res: Response) => any | Promise<any> =
      isScoped(input)
        ? (req, res) => input.factory(req, res)
        : (() => {
            const instance: any =
              typeof input === "function" ? new (input as Ctor)() : input;
            return () => instance;
          })();

    for (const route of meta.routes) {
      const params = (meta.params.get(route.handlerName) ?? [])
        .slice()
        .sort((a, b) => a.index - b.index);
      const explicitStatus = meta.httpCode.get(route.handlerName);
      const extraHeaders = meta.headers.get(route.handlerName);
      const redirect = meta.redirects.get(route.handlerName);
      // Order: global -> controller -> method.
      const guards: Guard[] = [
        ...globalGuards,
        ...meta.guards,
        ...(meta.methodGuards.get(route.handlerName) ?? []),
      ];
      const interceptors: Interceptor[] = [
        ...globalInterceptors,
        ...meta.interceptors,
        ...(meta.methodInterceptors.get(route.handlerName) ?? []),
      ];

      const path = joinPaths(globalPrefix, meta.prefix, route.path);
      const key = `${controllerName}.${route.handlerName}:${route.method}:${path}`;

      if (detectDuplicates && seen.has(key)) {
        throw new Error(
          `structex: ${route.method.toUpperCase()} ${path} ` +
            `(${controllerName}.${route.handlerName}) is already registered on ` +
            `this router. Pass { detectDuplicates: false } if this is intended.`,
        );
      }
      seen.add(key);

      const disposeScope = isScoped(input) ? input.dispose : undefined;

      const handler = async (
        req: Request,
        res: Response,
        next: NextFunction,
      ): Promise<void> => {
        if (disposeScope) {
          // Fires on normal completion and on client abort. `once` on both
          // with a guard, since only one of them may fire.
          let disposed = false;
          const cleanup = () => {
            if (disposed) return;
            disposed = true;
            void Promise.resolve(disposeScope(req, res)).catch((err) =>
              console.error(err),
            );
          };
          res.once("finish", cleanup);
          res.once("close", cleanup);
        }

        const ctx: ExecutionContext = {
          req,
          res,
          controller: controllerName,
          handler: route.handlerName,
          method: route.method,
          path,
        };

        try {
          for (const guard of guards) {
            const passed = await guard(req, res);
            if (res.headersSent) return; // guard answered the request itself
            if (!passed) throw new HttpError(403, "Forbidden");
          }

          const invoke = async (): Promise<unknown> => {
            const instance = await getInstance(req, res);
            const args = await resolveArgs(params, req, res, next);
            return instance[route.handlerName](...args);
          };

          const raw = await runInterceptors(interceptors, ctx, invoke);

          if (res.headersSent) return;

          if (route.sse) {
            if (raw === undefined) return; // handler wrote the stream itself
            await streamSse(res, req, raw as SseStream);
            return;
          }

          if (extraHeaders) res.set(extraHeaders);

          if (redirect) {
            const target = isRedirectResult(raw) ? raw : undefined;
            const url = target?.url ?? redirect.url;
            if (!url) {
              throw new HttpError(
                500,
                `@Redirect on ${controllerName}.${route.handlerName} has no url`,
              );
            }
            res.redirect(target?.status ?? redirect.status, url);
            return;
          }

          const envelope = isResponseEnvelope(raw) ? raw : undefined;
          const result = envelope ? envelope.body : raw;
          if (envelope?.headers) res.set(envelope.headers);

          const status =
            envelope?.status ?? explicitStatus ?? defaultStatus(route.method);

          if (EMPTY_BODY_STATUSES.has(status)) {
            res.status(status).end();
            return;
          }
          if (result === undefined) return; // handler opted out

          const serialized = serializeEnabled
            ? serialize(result, {
                groups: resolveGroups(serializeGroups, req),
              })
            : result;

          if (!transform) {
            res.status(status).json(serialized);
            return;
          }

          const body = transform(serialized, { ...ctx, status });
          // A transform that returns undefined means "no body" — end the
          // response rather than leaving the request hanging.
          if (body === undefined) {
            res.status(status).end();
            return;
          }
          res.status(status).json(body);
        } catch (err) {
          next(err);
        }
      };

      (app as any)[route.method](
        path,
        ...meta.middleware,
        ...route.middleware,
        handler,
      );

      registered.push({
        method: route.method,
        path,
        controller: controllerName,
        handler: route.handlerName,
        sse: Boolean(route.sse),
      });
    }
  }

  return registered;
}

/**
 * Returns the routes `registerControllers` would mount, without mounting them
 * and without instantiating any controller class.
 */
export function listRoutes(
  controllers: ControllerInput[],
  options: Pick<RegisterOptions, "prefix"> = {},
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const input of controllers) {
    const meta = metaOf(input);
    if (!meta) continue;
    const controllerName = ctorOf(input).name;

    for (const route of meta.routes) {
      routes.push({
        method: route.method,
        path: joinPaths(options.prefix ?? "", meta.prefix, route.path),
        controller: controllerName,
        handler: route.handlerName,
        sse: Boolean(route.sse),
      });
    }
  }

  return routes;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "36",
  POST: "32",
  PUT: "33",
  PATCH: "33",
  DELETE: "31",
  OPTIONS: "90",
  HEAD: "90",
};

function supportsColor(): boolean {
  return (
    !process.env.NO_COLOR &&
    (process.stdout.isTTY === true || Boolean(process.env.FORCE_COLOR))
  );
}

function paint(code: string, text: string): string {
  return supportsColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** Logs a route table. Handy as a boot-time sanity check. */
export function printRoutes(
  routes: RouteInfo[],
  log: (line: string) => void = console.log,
): void {
  if (routes.length === 0) {
    log("(no routes registered)");
    return;
  }
  const width = Math.max(...routes.map((r) => r.method.length));
  for (const route of routes) {
    const method = route.method.toUpperCase().padEnd(width);
    const color = METHOD_COLORS[route.method.toUpperCase()] ?? "37";
    log(
      `${paint(color, method)}  ${paint("1", route.path)}  ${paint("2", "→")}  ` +
        `${paint("2", `${route.controller}.${route.handler}`)}` +
        `${route.sse ? `  ${paint("35", "[sse]")}` : ""}`,
    );
  }
}
