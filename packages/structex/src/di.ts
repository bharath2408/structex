import type { Request, Response } from "express";
import type { Ctor } from "./register.js";

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

const TOKEN_BRAND = Symbol.for("structex.token");

export interface InjectionToken<T = unknown> {
  readonly [TOKEN_BRAND]: true;
  readonly key: symbol;
  readonly name: string;
  /** Phantom type, never present at runtime. */
  readonly _type?: T;
}

/**
 * Creates a typed injection token for values that have no class to key on
 * (config objects, connection strings, interfaces).
 *
 * ```ts
 * const DATABASE = token<Database>("DATABASE");
 * ```
 */
export function token<T>(name: string): InjectionToken<T> {
  return { [TOKEN_BRAND]: true, key: Symbol(name), name };
}

export function isInjectionToken(
  value: unknown,
): value is InjectionToken<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TOKEN_BRAND] === true
  );
}

/** Anything usable as a dependency key: a class or an `InjectionToken`. */
export type ProviderToken<T = any> = InjectionToken<T> | Ctor<T>;

type Key = symbol | Function;

function keyOf(target: ProviderToken): Key {
  return isInjectionToken(target) ? target.key : (target as Function);
}

function nameOf(target: ProviderToken): string {
  return isInjectionToken(target) ? target.name : (target as Function).name;
}

/** Built-in request-scoped tokens. */
export const REQUEST = token<Request>("REQUEST");
export const RESPONSE = token<Response>("RESPONSE");

/* ------------------------------------------------------------------ *
 * forwardRef / optional
 * ------------------------------------------------------------------ */

const FORWARD_REF = Symbol.for("structex.forwardRef");

export interface ForwardRef<T = any> {
  readonly [FORWARD_REF]: true;
  readonly resolve: () => ProviderToken<T>;
}

/**
 * Defers reading a token until resolution time.
 *
 * This solves **declaration order** — two classes in the same file, or a
 * circular import where one class is not yet defined when the decorator runs.
 * It does not make genuinely circular construction possible: if A needs a
 * fully built B and B needs a fully built A, that is still a cycle and still
 * throws.
 *
 * ```ts
 * class A { constructor(@Inject(forwardRef(() => B)) b: B) {} }
 * ```
 */
export function forwardRef<T>(resolve: () => ProviderToken<T>): ForwardRef<T> {
  return { [FORWARD_REF]: true, resolve };
}

export function isForwardRef(value: unknown): value is ForwardRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[FORWARD_REF] === true
  );
}

const OPTIONAL_DEP = Symbol.for("structex.optionalDep");

export interface OptionalDep<T = any> {
  readonly [OPTIONAL_DEP]: true;
  readonly dep: Dependency<T>;
}

/**
 * Marks a dependency as optional: `undefined` is injected instead of throwing
 * when no provider exists.
 *
 * ```ts
 * { provide: SERVICE, useFactory: (logger) => ..., inject: [optional(LOGGER)] }
 * ```
 */
export function optional<T>(dep: Dependency<T>): OptionalDep<T> {
  return { [OPTIONAL_DEP]: true, dep };
}

export function isOptionalDep(value: unknown): value is OptionalDep {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[OPTIONAL_DEP] === true
  );
}

/** Anything accepted in an `inject` array or by `@Inject`. */
export type Dependency<T = any> =
  | ProviderToken<T>
  | ForwardRef<T>
  | OptionalDep<T>;

/** Unwraps forwardRef/optional wrappers down to a concrete token. */
function unwrapDependency(dep: Dependency): {
  target: ProviderToken;
  isOptional: boolean;
} {
  let isOptional = false;
  let current: unknown = dep;

  // Wrappers may nest in either order: optional(forwardRef(...)) or vice versa.
  for (let guard = 0; guard < 8; guard++) {
    if (isOptionalDep(current)) {
      isOptional = true;
      current = current.dep;
      continue;
    }
    if (isForwardRef(current)) {
      current = current.resolve();
      continue;
    }
    break;
  }

  return { target: current as ProviderToken, isOptional };
}

/* ------------------------------------------------------------------ *
 * @Inject
 * ------------------------------------------------------------------ */

const constructorDeps = new WeakMap<Function, Dependency[]>();

/**
 * Declares a constructor dependency.
 *
 * Required on every injected parameter — without `reflect-metadata` there is
 * no type information to infer from, which is the deliberate trade for having
 * no runtime dependencies.
 *
 * ```ts
 * class UserService {
 *   constructor(@Inject(DATABASE) private db: Database) {}
 * }
 * ```
 */
export function Inject(dep: Dependency): ParameterDecorator {
  return (target, propertyKey, index) => {
    if (propertyKey !== undefined) return; // only constructor params
    const list = constructorDeps.get(target as Function) ?? [];
    list[index] = dep;
    constructorDeps.set(target as Function, list);
  };
}

/** Dependencies declared with `@Inject` on a class constructor. */
export function getConstructorDeps(
  target: Function,
): Dependency[] | undefined {
  const own = constructorDeps.get(target);
  if (own) return own;
  // Inherit when the subclass declares no constructor of its own.
  const parent = Object.getPrototypeOf(target) as Function | null;
  return parent && parent !== Function.prototype
    ? getConstructorDeps(parent)
    : undefined;
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

export type Scope = "singleton" | "request" | "transient";

export interface ValueProvider<T = any> {
  provide: ProviderToken<T>;
  useValue: T;
}

export interface ClassProvider<T = any> {
  provide: ProviderToken<T>;
  useClass: Ctor<T>;
  inject?: Dependency[];
  scope?: Scope;
}

export interface FactoryProvider<T = any> {
  provide: ProviderToken<T>;
  useFactory: (...deps: any[]) => T | Promise<T>;
  inject?: Dependency[];
  scope?: Scope;
}

export interface ExistingProvider<T = any> {
  provide: ProviderToken<T>;
  useExisting: ProviderToken<T>;
}

export type Provider<T = any> =
  | Ctor<T>
  | ValueProvider<T>
  | ClassProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;

/** Optional lifecycle hooks on any singleton provider instance. */
export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}
export interface OnDispose {
  onDispose(): void | Promise<void>;
}

interface Normalized {
  token: ProviderToken;
  key: Key;
  name: string;
  scope: Scope;
  inject: Dependency[];
  create: (deps: unknown[]) => unknown | Promise<unknown>;
  /** Set for `useValue` — already constructed, never re-created. */
  value?: { current: unknown };
  alias?: ProviderToken;
}

export function normalizeProvider(provider: Provider): Normalized {
  // Shorthand: a bare class.
  if (typeof provider === "function") {
    const ctor = provider as Ctor;
    return {
      token: ctor,
      key: keyOf(ctor),
      name: ctor.name,
      scope: "singleton",
      inject: getConstructorDeps(ctor) ?? [],
      create: (deps) => new ctor(...deps),
    };
  }

  const base = {
    token: provider.provide,
    key: keyOf(provider.provide),
    name: nameOf(provider.provide),
  };

  if ("useValue" in provider) {
    return {
      ...base,
      scope: "singleton",
      inject: [],
      create: () => provider.useValue,
      value: { current: provider.useValue },
    };
  }

  if ("useExisting" in provider) {
    return {
      ...base,
      scope: "transient",
      inject: [provider.useExisting],
      create: (deps) => deps[0],
      alias: provider.useExisting,
    };
  }

  if ("useClass" in provider) {
    const ctor = provider.useClass;
    return {
      ...base,
      scope: provider.scope ?? "singleton",
      inject: provider.inject ?? getConstructorDeps(ctor) ?? [],
      create: (deps) => new ctor(...deps),
    };
  }

  return {
    ...base,
    scope: provider.scope ?? "singleton",
    inject: provider.inject ?? [],
    create: (deps) => provider.useFactory(...deps),
  };
}

/* ------------------------------------------------------------------ *
 * Resolution context
 * ------------------------------------------------------------------ */

/** Per-request state; absent when resolving at boot. */
export interface RequestScope {
  req: Request;
  res: Response;
  cache: Map<Key, unknown>;
  /** Instances built in this scope, in creation order, for disposal. */
  created: unknown[];
}

export function createRequestScope(req: Request, res: Response): RequestScope {
  return { req, res, cache: new Map(), created: [] };
}

/**
 * Runs `onDispose()` on everything built during a request, newest first.
 *
 * Without this a request-scoped provider holding a transaction or connection
 * would leak one per request. Errors are caught so a failing hook cannot take
 * down the process after the response has already been sent.
 */
export async function disposeRequestScope(
  scope: RequestScope,
  onError: (err: unknown) => void = (err) => console.error(err),
): Promise<void> {
  for (const instance of [...scope.created].reverse()) {
    const hook = (instance as Partial<OnDispose>)?.onDispose;
    if (typeof hook !== "function") continue;
    try {
      await hook.call(instance);
    } catch (err) {
      onError(err);
    }
  }
  scope.created.length = 0;
  scope.cache.clear();
}

interface ResolveContext {
  scope?: RequestScope;
  /** Keys currently being constructed, for cycle detection. */
  stack: { key: Key; name: string }[];
}

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

/* ------------------------------------------------------------------ *
 * Container
 * ------------------------------------------------------------------ */

/**
 * Resolves providers, honouring module encapsulation: an imported container
 * only exposes the tokens its module exports.
 */
export class Container {
  private readonly own = new Map<Key, Normalized>();
  private readonly singletons = new Map<Key, unknown>();
  private readonly exported = new Set<Key>();
  private readonly imports: Container[] = [];
  /** Singleton instances in creation order, for ordered disposal. */
  private readonly created: unknown[] = [];
  private readonly requestScopedMemo = new Map<Key, boolean>();

  constructor(
    readonly name: string,
    providers: Provider[] = [],
  ) {
    for (const provider of providers) {
      const normalized = normalizeProvider(provider);
      this.own.set(normalized.key, normalized);
    }
  }

  addImport(container: Container): void {
    this.imports.push(container);
  }

  addExport(target: ProviderToken): void {
    this.exported.add(keyOf(target));
  }

  has(target: ProviderToken): boolean {
    return this.own.has(keyOf(target));
  }

  /** Every provider declared directly on this container. */
  ownProviders(): Normalized[] {
    return [...this.own.values()];
  }

  /**
   * Resolves a token.
   *
   * @param scope per-request state; omit at boot. Resolving a request-scoped
   *   provider without a scope throws.
   */
  async resolve<T>(target: ProviderToken<T>, scope?: RequestScope): Promise<T> {
    return this.resolveInternal(target, { scope, stack: [] }, false) as
      Promise<T>;
  }

  private async resolveInternal(
    target: ProviderToken,
    ctx: ResolveContext,
    viaImport: boolean,
  ): Promise<unknown> {
    const key = keyOf(target);

    // Built-in request tokens.
    if (key === REQUEST.key || key === RESPONSE.key) {
      if (!ctx.scope) {
        throw new DependencyError(
          `${nameOf(target)} is only available during a request. ` +
            `Mark the depending provider with scope: "request".`,
        );
      }
      return key === REQUEST.key ? ctx.scope.req : ctx.scope.res;
    }

    if (viaImport && !this.exported.has(key)) {
      throw new DependencyError(`${nameOf(target)} is not exported`);
    }

    const provider = this.own.get(key);
    if (!provider) {
      for (const imported of this.imports) {
        try {
          return await imported.resolveInternal(target, ctx, true);
        } catch (err) {
          if (err instanceof DependencyError) continue;
          throw err;
        }
      }
      const path = ctx.stack.map((f) => f.name).join(" -> ");
      throw new DependencyError(
        `No provider for ${nameOf(target)}` +
          (path ? ` (required by ${path})` : "") +
          `. Add it to a module's providers, or export it from an imported module.`,
      );
    }

    if (provider.value) return provider.value.current;

    // Request scope bubbles up: anything depending on request data cannot be
    // a singleton, no matter what scope it declared.
    const scope: Scope =
      provider.scope === "singleton" && this.isRequestScoped(provider.token)
        ? "request"
        : provider.scope;

    if (scope === "singleton" && this.singletons.has(key)) {
      return this.singletons.get(key);
    }
    if (scope === "request") {
      if (!ctx.scope) {
        throw new DependencyError(
          `${provider.name} is request-scoped and cannot be resolved at startup.`,
        );
      }
      if (ctx.scope.cache.has(key)) return ctx.scope.cache.get(key);
    }

    if (ctx.stack.some((frame) => frame.key === key)) {
      const cycle = [...ctx.stack.map((f) => f.name), provider.name].join(" -> ");
      throw new DependencyError(`Circular dependency: ${cycle}`);
    }

    ctx.stack.push({ key, name: provider.name });
    let instance: unknown;
    try {
      const deps: unknown[] = [];
      for (const dep of provider.inject) {
        if (dep === undefined) {
          throw new DependencyError(
            `${provider.name} has a constructor parameter without @Inject(). ` +
              `Every injected parameter must be annotated.`,
          );
        }
        const { target: depToken, isOptional } = unwrapDependency(dep);
        try {
          deps.push(await this.resolveInternal(depToken, ctx, false));
        } catch (err) {
          // An optional dependency tolerates a missing provider, but never
          // hides a cycle or an error thrown by a provider that does exist.
          if (
            isOptional &&
            err instanceof DependencyError &&
            /^No provider for/.test(err.message)
          ) {
            deps.push(undefined);
          } else {
            throw err;
          }
        }
      }
      instance = await provider.create(deps);
    } finally {
      ctx.stack.pop();
    }

    if (scope === "singleton") {
      this.singletons.set(key, instance);
      this.created.push(instance);
    } else if (scope === "request") {
      ctx.scope!.cache.set(key, instance);
      ctx.scope!.created.push(instance);
    }

    return instance;
  }

  /**
   * True when this token, or anything it depends on, is request-scoped —
   * meaning it cannot be a singleton. Memoized, so call it only after the
   * module graph is fully wired.
   */
  isRequestScoped(target: ProviderToken, seen = new Set<Key>()): boolean {
    const key = keyOf(target);
    const memo = this.requestScopedMemo.get(key);
    if (memo !== undefined) return memo;

    const result = this.computeRequestScoped(target, seen);
    // Only memoize a complete answer: a cycle-truncated `false` may be wrong.
    if (seen.size === 0 || result) this.requestScopedMemo.set(key, result);
    return result;
  }

  private computeRequestScoped(target: ProviderToken, seen: Set<Key>): boolean {
    const key = keyOf(target);
    if (key === REQUEST.key || key === RESPONSE.key) return true;
    if (seen.has(key)) return false;
    seen.add(key);

    const provider = this.own.get(key);
    if (!provider) {
      return this.imports.some(
        (imported) =>
          imported.exported.has(key) &&
          imported.computeRequestScoped(target, seen),
      );
    }
    if (provider.scope === "request") return true;
    return provider.inject.some((dep) => {
      if (dep === undefined) return false;
      try {
        return this.computeRequestScoped(unwrapDependency(dep).target, seen);
      } catch {
        // A forwardRef that cannot resolve yet is assumed not request-scoped.
        return false;
      }
    });
  }

  /** Eagerly builds every singleton so wiring errors surface at boot. */
  async instantiateSingletons(): Promise<void> {
    for (const provider of this.own.values()) {
      if (provider.scope !== "singleton" || provider.value) continue;
      if (this.isRequestScoped(provider.token)) continue;
      await this.resolve(provider.token);
    }
  }

  /** Calls `onModuleInit()` on every singleton that defines it. */
  async runInitHooks(): Promise<void> {
    for (const instance of this.created) {
      const hook = (instance as Partial<OnModuleInit>)?.onModuleInit;
      if (typeof hook === "function") await hook.call(instance);
    }
  }

  /** Calls `onDispose()` in reverse creation order. */
  async dispose(): Promise<void> {
    for (const instance of [...this.created].reverse()) {
      const hook = (instance as Partial<OnDispose>)?.onDispose;
      if (typeof hook === "function") await hook.call(instance);
    }
    this.created.length = 0;
    this.singletons.clear();
  }
}
