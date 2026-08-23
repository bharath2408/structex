import type { NextFunction, Request, RequestHandler, Response } from "express";
import { assertLegacyDecorators } from "./serialization.js";
import {
  getMeta,
  type ApiDocDefinition,
  type Guard,
  type HttpMethod,
  type Interceptor,
  type Pipe,
  type PipeMeta,
} from "./metadata.js";

/* ------------------------------------------------------------------ *
 * Class
 * ------------------------------------------------------------------ */

/**
 * Marks a class as a controller and sets its path prefix.
 *
 * @example
 * ```ts
 * @Controller("/users", authMiddleware)
 * class UserController {}
 * ```
 */
export function Controller(
  prefix = "",
  ...middleware: RequestHandler[]
): ClassDecorator {
  return (target) => {
    const meta = getMeta(target);
    meta.prefix = prefix;
    meta.middleware = middleware;
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function createMethodDecorator(method: HttpMethod) {
  return (path = "", ...middleware: RequestHandler[]): MethodDecorator =>
    (target, propertyKey) => {
      assertLegacyDecorators(target, method.charAt(0).toUpperCase() + method.slice(1));
      getMeta(target.constructor).routes.push({
        method,
        path,
        handlerName: String(propertyKey),
        middleware,
      });
    };
}

export const Get = createMethodDecorator("get");
export const Post = createMethodDecorator("post");
export const Put = createMethodDecorator("put");
export const Patch = createMethodDecorator("patch");
export const Delete = createMethodDecorator("delete");
export const Options = createMethodDecorator("options");
export const Head = createMethodDecorator("head");

/** Build a decorator for a verb not covered above. */
export function Route(method: HttpMethod) {
  return createMethodDecorator(method);
}

/**
 * Registers a `text/event-stream` GET route. The handler returns an iterable
 * or async iterable of events; the stream closes when it completes or the
 * client disconnects.
 *
 * ```ts
 * @Sse("/events")
 * async *events(): AsyncGenerator<SseEvent<Tick>> {
 *   for await (const tick of this.ticker) yield { event: "tick", data: tick };
 * }
 * ```
 */
export function Sse(
  path = "",
  ...middleware: RequestHandler[]
): MethodDecorator {
  return (target, propertyKey) => {
    getMeta(target.constructor).routes.push({
      method: "get",
      path,
      handlerName: String(propertyKey),
      middleware,
      sse: true,
    });
  };
}

/* ------------------------------------------------------------------ *
 * Response shaping
 * ------------------------------------------------------------------ */

/**
 * Overrides the success status. Defaults are 201 for POST, 200 otherwise.
 * A 204 or 304 sends an empty body regardless of what the handler returns.
 * `respond(body, { status })` overrides this per request.
 */
export function HttpCode(status: number): MethodDecorator {
  return (target, propertyKey) => {
    getMeta(target.constructor).httpCode.set(String(propertyKey), status);
  };
}

/** Adds a response header. Repeatable. */
export function Header(name: string, value: string): MethodDecorator {
  return (target, propertyKey) => {
    const meta = getMeta(target.constructor);
    const key = String(propertyKey);
    meta.headers.set(key, { ...(meta.headers.get(key) ?? {}), [name]: value });
  };
}

/**
 * Redirects instead of sending a body. The handler may return
 * `{ url, status? }` to override the target at runtime, or `undefined` to use
 * the decorator's values.
 */
export function Redirect(url = "", status = 302): MethodDecorator {
  return (target, propertyKey) => {
    getMeta(target.constructor).redirects.set(String(propertyKey), {
      url,
      status,
    });
  };
}

/* ------------------------------------------------------------------ *
 * Guards and interceptors
 * ------------------------------------------------------------------ */

/**
 * Applies guards to a whole controller (on a class) or a single route (on a
 * method). Class guards run first. Decorator position relative to the route
 * decorator does not matter.
 */
export function UseGuards(
  ...guards: Guard[]
): ClassDecorator & MethodDecorator {
  return ((target: any, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      getMeta(target as Function).guards.push(...guards);
      return;
    }
    const meta = getMeta(target.constructor as Function);
    const name = String(propertyKey);
    meta.methodGuards.set(name, [
      ...(meta.methodGuards.get(name) ?? []),
      ...guards,
    ]);
  }) as ClassDecorator & MethodDecorator;
}

/**
 * Wraps parameter resolution and handler invocation. Class interceptors are
 * outermost, then method interceptors, in declaration order.
 */
export function UseInterceptors(
  ...interceptors: Interceptor[]
): ClassDecorator & MethodDecorator {
  return ((target: any, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      getMeta(target as Function).interceptors.push(...interceptors);
      return;
    }
    const meta = getMeta(target.constructor as Function);
    const name = String(propertyKey);
    meta.methodInterceptors.set(name, [
      ...(meta.methodInterceptors.get(name) ?? []),
      ...interceptors,
    ]);
  }) as ClassDecorator & MethodDecorator;
}

/* ------------------------------------------------------------------ *
 * OpenAPI enrichment
 * ------------------------------------------------------------------ */

/**
 * Attaches OpenAPI metadata read by `toOpenApi`. On a class it sets default
 * tags for every route; on a method it enriches that operation.
 *
 * Nothing is inferred from TypeScript types — schemas are supplied by you.
 */
export function ApiDoc(
  doc: ApiDocDefinition | string,
): ClassDecorator & MethodDecorator {
  return ((target: any, propertyKey?: string | symbol) => {
    const normalized: ApiDocDefinition =
      typeof doc === "string" ? { summary: doc } : doc;

    if (propertyKey === undefined) {
      const meta = getMeta(target as Function);
      if (normalized.tags) meta.tags = normalized.tags;
      return;
    }
    const meta = getMeta(target.constructor as Function);
    const name = String(propertyKey);
    meta.apiDocs.set(name, { ...(meta.apiDocs.get(name) ?? {}), ...normalized });
  }) as ClassDecorator & MethodDecorator;
}

/* ------------------------------------------------------------------ *
 * Parameters
 * ------------------------------------------------------------------ */

/**
 * Builds a custom parameter decorator.
 *
 * @example
 * ```ts
 * const CurrentUser = () => createParamDecorator((req) => req.user);
 * ```
 */
export function createParamDecorator(
  resolve: (req: Request, res: Response, next: NextFunction) => unknown,
  meta: PipeMeta = { type: "custom" },
  pipes: Pipe[] = [],
): ParameterDecorator {
  return (target, propertyKey, index) => {
    if (propertyKey === undefined) return; // constructor params unsupported
    assertLegacyDecorators(target, "param decorator");
    const controllerMeta = getMeta(target.constructor);
    const name = String(propertyKey);
    const list = controllerMeta.params.get(name) ?? [];
    list.push({ index, resolve, meta, pipes });
    controllerMeta.params.set(name, list);
  };
}

export interface ParamDecoratorFactory {
  (): ParameterDecorator;
  (...pipes: Pipe[]): ParameterDecorator;
  (key: string, ...pipes: Pipe[]): ParameterDecorator;
}

function paramFactory(
  type: PipeMeta["type"],
  read: (req: Request, key?: string) => unknown,
): ParamDecoratorFactory {
  return ((keyOrPipe?: string | Pipe, ...rest: Pipe[]): ParameterDecorator => {
    const key = typeof keyOrPipe === "string" ? keyOrPipe : undefined;
    const pipes = typeof keyOrPipe === "function" ? [keyOrPipe, ...rest] : rest;
    return createParamDecorator((req) => read(req, key), { type, key }, pipes);
  }) as ParamDecoratorFactory;
}

/** `@Body()`, `@Body("email")`, `@Body(parseWith(schema))` */
export const Body = paramFactory("body", (req, key) =>
  key ? (req.body as Record<string, unknown> | undefined)?.[key] : req.body,
);

/** `@Param("id")` — omit the key for the whole params object. */
export const Param = paramFactory("param", (req, key) =>
  key ? req.params[key] : req.params,
);

/** `@Query("page", toInt)` */
export const Query = paramFactory("query", (req, key) =>
  key ? (req.query as Record<string, unknown>)[key] : req.query,
);

/** `@Headers("authorization")` — key is lower-cased for you. */
export const Headers = paramFactory("headers", (req, key) =>
  key ? req.headers[key.toLowerCase()] : req.headers,
);

/** `@Cookies("session")` — requires cookie-parser middleware. */
export const Cookies = paramFactory("cookie", (req, key) => {
  const cookies = (req as Request & { cookies?: Record<string, unknown> })
    .cookies;
  return key ? cookies?.[key] : cookies;
});

/** Requires multer (or similar) middleware to populate `req.file`. */
export const UploadedFile = paramFactory(
  "file",
  (req) => (req as Request & { file?: unknown }).file,
);

/** Requires multer (or similar) middleware to populate `req.files`. */
export const UploadedFiles = paramFactory(
  "files",
  (req) => (req as Request & { files?: unknown }).files,
);

export const Req = (): ParameterDecorator => createParamDecorator((req) => req);
export const Res = (): ParameterDecorator =>
  createParamDecorator((_req, res) => res);
export const Next = (): ParameterDecorator =>
  createParamDecorator((_req, _res, next) => next);

/** Client IP, honouring `trust proxy` when you have configured it. */
export const Ip = (): ParameterDecorator =>
  createParamDecorator((req) => req.ip);
