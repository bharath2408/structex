import type { NextFunction, Request, RequestHandler, Response } from "express";

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head";

/**
 * Return `false` to reject with 403, or throw an `HttpError` for a precise
 * status and message. Writing to `res` yourself short-circuits the request.
 */
export type Guard = (req: Request, res: Response) => boolean | Promise<boolean>;

/** Describes where a decorated argument came from, for error messages. */
export interface PipeMeta {
  type:
    | "body"
    | "param"
    | "query"
    | "headers"
    | "cookie"
    | "file"
    | "files"
    | "custom";
  key?: string;
}

/** Transforms and/or validates a resolved argument. Throw to reject. */
export type Pipe<In = any, Out = any> = (
  value: In,
  meta: PipeMeta,
) => Out | Promise<Out>;

/** Identifies the route currently executing. */
export interface ExecutionContext {
  req: Request;
  res: Response;
  controller: string;
  handler: string;
  method: HttpMethod;
  path: string;
}

/**
 * Wraps parameter resolution and handler invocation. Call `next()` to continue
 * the chain; whatever the outermost interceptor returns becomes the response
 * body. The first interceptor declared is the outermost.
 */
export type Interceptor = (
  ctx: ExecutionContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export interface ParamDefinition {
  index: number;
  meta: PipeMeta;
  resolve: (req: Request, res: Response, next: NextFunction) => unknown;
  pipes: Pipe[];
}

export interface RedirectDefinition {
  url: string;
  status: number;
}

/** Free-form OpenAPI enrichment attached by `@ApiDoc`. */
export interface ApiDocDefinition {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  operationId?: string;
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: unknown[];
}

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string;
  middleware: RequestHandler[];
  /** Set by `@Sse` — the handler streams events instead of returning a body. */
  sse?: boolean;
}

export interface ControllerMeta {
  prefix: string;
  middleware: RequestHandler[];
  /** Guards applied to every route on the controller. */
  guards: Guard[];
  /** Interceptors applied to every route on the controller. */
  interceptors: Interceptor[];
  /** Default tags for every route, used by `toOpenApi`. */
  tags: string[];
  /** Set by `@Version` on the class. A method's own `@Version` wins over this. */
  version?: string;
  routes: RouteDefinition[];
  /** handlerName -> parameter definitions */
  params: Map<string, ParamDefinition[]>;
  /** handlerName -> guards for that handler only */
  methodGuards: Map<string, Guard[]>;
  /** handlerName -> interceptors for that handler only */
  methodInterceptors: Map<string, Interceptor[]>;
  /** handlerName -> explicit success status */
  httpCode: Map<string, number>;
  /** handlerName -> extra response headers */
  headers: Map<string, Record<string, string>>;
  /** handlerName -> redirect target */
  redirects: Map<string, RedirectDefinition>;
  /** handlerName -> OpenAPI enrichment */
  apiDocs: Map<string, ApiDocDefinition>;
  /** handlerName -> `@Version` override for that route only */
  methodVersions: Map<string, string>;
}

const store = new WeakMap<Function, ControllerMeta>();

function emptyMeta(): ControllerMeta {
  return {
    prefix: "",
    middleware: [],
    guards: [],
    interceptors: [],
    tags: [],
    routes: [],
    params: new Map(),
    methodGuards: new Map(),
    methodInterceptors: new Map(),
    httpCode: new Map(),
    headers: new Map(),
    redirects: new Map(),
    apiDocs: new Map(),
    methodVersions: new Map(),
  };
}

/**
 * Get-or-create the metadata bucket for exactly this class. Decorators write
 * here; nothing inherited is visible.
 */
export function getMeta(target: Function): ControllerMeta {
  let meta = store.get(target);
  if (!meta) {
    meta = emptyMeta();
    store.set(target, meta);
  }
  return meta;
}

export function hasMeta(target: Function): boolean {
  return store.has(target);
}

/**
 * Metadata for a class including everything inherited from decorated base
 * classes. Bases are merged first so derived declarations win.
 *
 * Returns `undefined` when neither the class nor any ancestor was decorated.
 */
export function resolveMeta(target: Function): ControllerMeta | undefined {
  const chain: Function[] = [];
  let current: Function | null = target;

  while (current && current !== Function.prototype) {
    if (store.has(current)) chain.unshift(current); // base -> derived
    current = Object.getPrototypeOf(current) as Function | null;
  }
  if (chain.length === 0) return undefined;

  const merged = emptyMeta();

  for (const cls of chain) {
    const meta = store.get(cls)!;

    if (meta.prefix) merged.prefix = meta.prefix;
    if (meta.middleware.length) merged.middleware = meta.middleware;
    if (meta.tags.length) merged.tags = meta.tags;
    if (meta.version !== undefined) merged.version = meta.version;
    merged.guards.push(...meta.guards);
    merged.interceptors.push(...meta.interceptors);

    for (const route of meta.routes) {
      const existing = merged.routes.findIndex(
        (r) => r.handlerName === route.handlerName && r.method === route.method,
      );
      if (existing >= 0) merged.routes[existing] = route;
      else merged.routes.push(route);
    }

    for (const [key, value] of meta.params) merged.params.set(key, value);
    for (const [key, value] of meta.methodGuards) {
      merged.methodGuards.set(key, [
        ...(merged.methodGuards.get(key) ?? []),
        ...value,
      ]);
    }
    for (const [key, value] of meta.methodInterceptors) {
      merged.methodInterceptors.set(key, [
        ...(merged.methodInterceptors.get(key) ?? []),
        ...value,
      ]);
    }
    for (const [key, value] of meta.httpCode) merged.httpCode.set(key, value);
    for (const [key, value] of meta.headers) {
      merged.headers.set(key, { ...(merged.headers.get(key) ?? {}), ...value });
    }
    for (const [key, value] of meta.redirects) merged.redirects.set(key, value);
    for (const [key, value] of meta.methodVersions) {
      merged.methodVersions.set(key, value);
    }
    for (const [key, value] of meta.apiDocs) {
      merged.apiDocs.set(key, { ...(merged.apiDocs.get(key) ?? {}), ...value });
    }
  }

  return merged;
}
