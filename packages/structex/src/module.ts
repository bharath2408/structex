import type { IRouter, RequestHandler } from "express";
import {
  Container,
  DependencyError,
  createRequestScope,
  disposeRequestScope,
  type Provider,
  type ProviderToken,
  type RequestScope,
} from "./di.js";
import type { Guard, Interceptor } from "./metadata.js";
import {
  joinPaths,
  registerControllers,
  scoped,
  type Ctor,
  type RegisterOptions,
  type RouteInfo,
} from "./register.js";

const MODULE_BRAND = Symbol.for("structex.module");

export interface ModuleDefinition {
  /** Used in error messages and `ApplicationRef.modules`. */
  name?: string;
  /** Other modules whose exported providers become visible here. */
  imports?: ModuleRef[];
  /** Providers private to this module unless listed in `exports`. */
  providers?: Provider[];
  /** Controllers mounted by this module. */
  controllers?: Ctor[];
  /** Tokens made visible to modules that import this one. */
  exports?: ProviderToken[];
  /** Prepended to every controller prefix in this module. */
  prefix?: string;
  /** Middleware mounted at the module prefix, before its routes. */
  middleware?: RequestHandler[];
  /** Guards applied to every controller in this module. */
  guards?: Guard[];
  /** Interceptors applied to every controller in this module. */
  interceptors?: Interceptor[];
}

export interface ModuleRef {
  readonly [MODULE_BRAND]: true;
  readonly definition: ModuleDefinition;
  readonly name: string;
}

/**
 * Groups controllers and providers into an encapsulated unit.
 *
 * Providers are private by default — an importing module sees only what
 * `exports` lists. That boundary is the entire point; without it a module is
 * just an array.
 *
 * ```ts
 * const UserModule = defineModule({
 *   name: "UserModule",
 *   imports: [DatabaseModule],
 *   providers: [UserService],
 *   controllers: [UserController],
 *   exports: [UserService],
 * });
 * ```
 */
export function defineModule(definition: ModuleDefinition): ModuleRef {
  return {
    [MODULE_BRAND]: true,
    definition,
    name: definition.name ?? "AnonymousModule",
  };
}

export function isModuleRef(value: unknown): value is ModuleRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[MODULE_BRAND] === true
  );
}

export interface ApplicationOptions
  extends Omit<RegisterOptions, "prefix"> {
  /** Prepended to every module prefix. */
  prefix?: string;
}

export interface ApplicationRef {
  routes: RouteInfo[];
  /** Module name -> its container, for tests and diagnostics. */
  containers: Map<string, Container>;
  modules: string[];
  /** Resolves a token from the root module's container. */
  resolve<T>(target: ProviderToken<T>): Promise<T>;
  /** Runs `onDispose()` on every singleton, deepest module first. */
  close(): Promise<void>;
}

interface Compiled {
  ref: ModuleRef;
  container: Container;
}

/**
 * Compiles a module graph in dependency order, deduplicating shared modules
 * so an imported module is instantiated exactly once.
 */
function compile(root: ModuleRef): Compiled[] {
  const built = new Map<ModuleRef, Container>();
  const order: Compiled[] = [];
  const visiting = new Set<ModuleRef>();
  const path: string[] = [];

  const walk = (ref: ModuleRef): Container => {
    const existing = built.get(ref);
    if (existing) return existing;

    if (visiting.has(ref)) {
      throw new DependencyError(
        `Circular module imports: ${[...path, ref.name].join(" -> ")}`,
      );
    }
    visiting.add(ref);
    path.push(ref.name);

    const { imports = [], providers = [], controllers = [], exports = [] } =
      ref.definition;

    // Controllers are providers too, so they can take injected dependencies.
    const controllerProviders: Provider[] = controllers
      .filter(
        (ctor) =>
          !providers.some(
            (p) => typeof p !== "function" && p.provide === ctor,
          ),
      )
      .map((ctor) => ctor as Provider);

    const container = new Container(ref.name, [
      ...providers,
      ...controllerProviders,
    ]);

    for (const imported of imports) {
      if (!isModuleRef(imported)) {
        throw new DependencyError(
          `${ref.name} imports something that is not a module. ` +
            `Did you forget defineModule()?`,
        );
      }
      container.addImport(walk(imported));
    }

    for (const exported of exports) {
      container.addExport(exported);
    }

    visiting.delete(ref);
    path.pop();
    built.set(ref, container);
    order.push({ ref, container });
    return container;
  };

  walk(root);
  return order; // imports first, root last
}

/**
 * Builds the container graph, resolves every controller, and mounts routes.
 *
 * Async because factory providers may be async (opening a database connection,
 * reading a secret). Singletons are created eagerly, so a missing or circular
 * dependency fails at startup rather than on the first request.
 *
 * ```ts
 * const application = await createApplication(app, AppModule, { prefix: "/api" });
 * printRoutes(application.routes);
 * ```
 */
export async function createApplication(
  app: IRouter,
  root: ModuleRef,
  options: ApplicationOptions = {},
): Promise<ApplicationRef> {
  const { prefix: globalPrefix = "", ...registerOptions } = options;
  const compiled = compile(root);
  const routes: RouteInfo[] = [];
  const containers = new Map<string, Container>();

  for (const { ref, container } of compiled) {
    await container.instantiateSingletons();
    containers.set(ref.name, container);
  }

  for (const { ref, container } of compiled) {
    const { controllers = [], prefix = "", middleware = [] } = ref.definition;
    if (controllers.length === 0 && middleware.length === 0) continue;

    const modulePrefix = joinPaths(globalPrefix, prefix);

    if (middleware.length) {
      // Mounted before this module's routes, scoped to its prefix.
      (app as unknown as { use: (...args: unknown[]) => void }).use(
        modulePrefix,
        ...middleware,
      );
    }

    // One scope per response, so every provider built during a request shares
    // it and can be disposed together when the response completes.
    const scopes = new WeakMap<object, RequestScope>();

    const inputs = await Promise.all(
      controllers.map(async (ctor) =>
        container.isRequestScoped(ctor)
          ? scoped(
              ctor,
              (req, res) => {
                const scope = createRequestScope(req, res);
                scopes.set(res, scope);
                return container.resolve(ctor, scope);
              },
              async (_req, res) => {
                const scope = scopes.get(res);
                if (!scope) return;
                scopes.delete(res);
                await disposeRequestScope(scope);
              },
            )
          : await container.resolve(ctor),
      ),
    );

    routes.push(
      ...registerControllers(app, inputs, {
        ...registerOptions,
        prefix: modulePrefix,
        // Module guards sit between global and controller guards.
        guards: [...(registerOptions.guards ?? []), ...(ref.definition.guards ?? [])],
        interceptors: [
          ...(registerOptions.interceptors ?? []),
          ...(ref.definition.interceptors ?? []),
        ],
      }),
    );
  }

  // Init hooks after every container is built, so cross-module deps are ready.
  for (const { container } of compiled) {
    await container.runInitHooks();
  }

  const rootContainer = compiled[compiled.length - 1]!.container;

  return {
    routes,
    containers,
    modules: compiled.map((c) => c.ref.name),
    resolve: (target) => rootContainer.resolve(target),
    close: async () => {
      // Reverse of creation order: root first, shared modules last.
      for (const { container } of [...compiled].reverse()) {
        await container.dispose();
      }
    },
  };
}
