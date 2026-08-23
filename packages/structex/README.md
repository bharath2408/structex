# structex

**Structure for Express — without leaving Express behind.**

If you know Express but don't want to learn NestJS to get organized code, this is for you. Controllers, DI, and modules on top of the Express you already know: `app.use()` still works, middleware is still `RequestHandler`, and `@Res()` hands you the real response object.

```bash
npx create-structex my-api
```

- **No runtime dependencies.** No `reflect-metadata`. Metadata lives in a `WeakMap`.
- **Express 4 and 5.** Async handler rejections always reach your error handler.
- **Escape hatches everywhere.** Any abstraction can be dropped for plain Express.
- **Adopt gradually.** Start with `registerControllers`, move to modules and DI only if you want them.

## Install

```bash
npm install structex express
```

`express` is a peer dependency (`^4.18.0 || ^5.0.0`), so you keep exactly one copy.

## Entry points

| Import | Contains |
|---|---|
| `structex` | Everything — decorators, routing, errors, responses |
| `structex/di` | `token`, `Inject`, `Container`, `defineModule`, `createApplication` |
| `structex/pipes` | `toInt`, `trim`, `required`, `parseWith`, … |
| `structex/interceptors` | `timing`, `timeout`, `cache`, `retry`, `envelope` |
| `structex/openapi` | `toOpenApi`, `toOpenApiPath` |
| `structex/serialization` | `Exclude`, `Expose`, `Transform`, `serialize` |
| `structex/testing` | `createTestApp` |

Subpaths are curated subsets of the root export, not separate bundles — so there is exactly one metadata store no matter which paths you import from.

## CLI

```bash
npx create-structex my-api                    # modules template
npx create-structex my-api --template minimal # no DI, no modules
npx structex g resource orders                # module + controller + service
npx structex g controller health
npx structex g guard admin --dir src/common --flat
```

Kinds: `controller`, `service`, `module`, `guard`, `interceptor`, `pipe`, `resource`. Generators never overwrite an existing file without `--force`.

## When not to use this

If you'll want `@nestjs/swagger`, TypeORM integration, or microservice transports within six months, migrate to NestJS now rather than later. Nest's real value is its ecosystem, and this package doesn't try to replace it.

## ⚠️ Required TypeScript setting

This package uses **legacy decorators**, because TypeScript's standard (Stage 3) decorators do not support parameter decorators — and `@Body()` / `@Param()` are parameter decorators.

You must set this in **your** `tsconfig.json`, not just ours:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

Without it you'll get `TS1241: Unable to resolve signature of method decorator when called as an expression` on every route. You do **not** need `emitDecoratorMetadata`.

If you build with esbuild, tsup, SWC, or Vite, that flag has to reach the transform too — see [Bundlers](#bundlers) below.

---

## Quick start

```ts
import express from "express";
import {
  Controller, Get, Post, Delete,
  Body, Param, Query,
  HttpCode, UseGuards,
  registerControllers, printRoutes,
  NotFound, isHttpError,
  toInt, clamp, type Guard,
} from "structex";

const authenticated: Guard = (req) => Boolean((req as any).user);

@Controller("/users")
class UserController {
  constructor(private readonly db: Db) {}

  @Get("/")
  list(@Query("page", toInt, clamp(1, 100)) page = 1) {
    return this.db.users.page(page);
  }

  @Get("/:id")
  async findOne(@Param("id") id: string) {
    const user = await this.db.users.find(id);
    if (!user) throw NotFound(`User ${id} not found`);
    return user;                                  // 200 + JSON
  }

  @Post("/")
  @UseGuards(authenticated)
  create(@Body() dto: CreateUserDto) {
    return this.db.users.create(dto);             // 201 + JSON
  }

  @Delete("/:id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    await this.db.users.delete(id);               // 204, empty body
  }
}

const app = express();
app.use(express.json());

const routes = registerControllers(app, [new UserController(db)], {
  prefix: "/api/v1",
});
printRoutes(routes);

app.use((err, _req, res, _next) => {
  const status = isHttpError(err) ? err.status : 500;
  res.status(status).json({
    message: status === 500 ? "Internal server error" : err.message,
    ...(isHttpError(err) && err.details ? { details: err.details } : {}),
  });
});

app.listen(3000);
```

---

## Response conventions

| Handler does | Response |
|---|---|
| returns a value | `200` JSON (`201` for POST) |
| returns `respond(body, { status })` | that status, per request |
| returns `undefined` | nothing sent — you own the response |
| writes to `res` | respected; nothing else is sent |
| throws `HttpError` | forwarded to `next(err)` with its status |
| throws anything else | forwarded to `next(err)` |
| has `@HttpCode(204)` | empty body, even if a value is returned |
| has `@Redirect(url)` | `302` (or the returned `{ url, status }`) |
| has `@Sse()` | `text/event-stream`, one frame per yielded event |

### Dynamic status without `@Res()`

```ts
import { respond } from "structex";

@Put("/:id")
upsert(@Param("id") id: string, @Body() dto: Dto) {
  const { record, created } = this.repo.upsert(id, dto);
  return respond(record, { status: created ? 201 : 200 });
}
```

### App-wide envelope

`transform` runs on every successful JSON body. It is skipped for redirects, SSE, empty-body statuses, and anything written through `@Res()`.

```ts
registerControllers(app, controllers, {
  transform: (result, ctx) => ({
    data: result,
    meta: { status: ctx.status, path: ctx.path },
  }),
});
```

Returning `undefined` from `transform` sends the status with an empty body.

---

## Interceptors

An interceptor wraps parameter resolution *and* the handler call. Class interceptors are outermost, then method interceptors, in declaration order.

```ts
import { UseInterceptors } from "structex";
import { timing, cache, timeout, retry, type Interceptor } from "structex/interceptors";

const correlate: Interceptor = async (ctx, next) => {
  ctx.res.set("X-Request-Id", ctx.req.header("x-request-id") ?? crypto.randomUUID());
  return next();
};

@Controller("/reports")
@UseInterceptors(correlate, timing())
class ReportController {
  @Get("/summary")
  @UseInterceptors(cache({ ttl: 30_000 }), timeout(5_000))
  summary() {
    return this.db.expensiveAggregate();
  }
}
```

Built in: `timing(log?)` · `timeout(ms, status?)` · `cache({ ttl, max?, key? })` · `retry({ attempts, delay?, shouldRetry? })` · `envelope(wrap?)`

**`next()` may be called more than once** — that is exactly how `retry` works. Each call re-runs parameter resolution and the handler, so anything under a re-invoking interceptor must be idempotent.

Caveats worth knowing: `cache` is per-process and not shared across workers, so key it by user if the output varies per user. `timeout` rejects the response but cannot cancel the handler's work — use an `AbortSignal` for real cancellation. `retry` on a POST can create duplicates.

---

## Server-sent events

```ts
import { Sse, type SseEvent } from "structex";

@Controller("/live")
class LiveController {
  @Sse("/ticks")
  async *ticks(): AsyncGenerator<SseEvent<Tick>> {
    for await (const tick of this.ticker) {
      yield { event: "tick", id: tick.id, data: tick };
    }
  }
}
```

Headers, framing, and stream teardown on client disconnect are handled for you. Return `undefined` and take `@Res()` if you want to write the stream yourself. Multi-line payloads are split across `data:` lines correctly.

---

## Per-request instances

```ts
import { scoped } from "structex";

registerControllers(app, [
  new UserController(db),                                  // singleton
  scoped(OrderController, (req) =>                         // fresh per request
    new OrderController(db.forTenant(req.tenantId))),
]);
```

Route metadata is read from the class, so the factory is never called at boot — only per request. Prefer a plain instance when nothing varies per request; `scoped` allocates on every call.

This is the extent of the DI story: explicit factories, no container, no decorator-driven injection.

---

## Testing controllers

```ts
import express from "express";
import request from "supertest";
import { createTestApp } from "structex/testing";

const { app } = createTestApp([new UserController(fakeRepo)], {
  express,                          // passed in, so no second Express copy
  user: { id: "u_1", role: "admin" },
});

await request(app).get("/users/u_1").expect(200);
```

JSON parsing and a default error handler are included; override either through the options.

---

## OpenAPI

```ts
import { ApiDoc } from "structex";
import { toOpenApi } from "structex/openapi";

@Controller("/users")
@ApiDoc({ tags: ["Users"] })
class UserController {
  @Get("/:id")
  @ApiDoc({ summary: "Fetch a user", responses: { "200": { description: "ok" } } })
  findOne(@Param("id") id: string) {}
}

const spec = toOpenApi([UserController], {
  info: { title: "API", version: "1.0.0" },
  prefix: "/api/v1",
});
app.get("/openapi.json", (_req, res) => res.json(spec));
```

Paths, methods, and path parameters are derived from your routes; `/users/:id` becomes `/users/{id}`. **Schemas are not inferred** — inferring them from TypeScript types would require `reflect-metadata`, which is exactly the dependency this package avoids. Supply `requestBody` and `responses` yourself, e.g. from `zod-to-json-schema`.

---


---

---

## Serialization

The problem: returning a domain object straight from a handler sends **every**
field on it, including `passwordHash`. Mark the field once on the class and
omission becomes the default instead of something you must remember at each
call site.

```ts
import { Exclude, Expose, Transform } from "structex/serialization";

class User {
  id!: string;
  email!: string;

  @Exclude()
  passwordHash!: string;                       // never serialized

  @Expose({ name: "displayName" })
  name!: string;                               // renamed in the response

  @Expose({ groups: ["admin"] })
  riskScore!: number;                          // only when "admin" is active

  @Transform((value) => (value as Date).toISOString().slice(0, 10))
  createdAt!: Date;
}
```

Enabled by default and a no-op until a field is decorated. Arrays and nested
instances are handled, and circular references are safe.

Groups are resolved per request:

```ts
registerControllers(app, controllers, {
  serialize: {
    groups: (req) => (req.user?.role === "admin" ? ["admin"] : []),
  },
});
```

**Rules live on the class, so this only applies to class instances.** Plain
objects pass through untouched — if your repository returns raw rows, map them
into a class or the rules will not fire. Pass `serialize: false` to disable.

Order in the response path: handler → serialize → `transform` → JSON.

---

## Error handling

```ts
import { createErrorHandler } from "structex";

app.use(createErrorHandler());          // mount after your routes
```

| Option | Default | |
|---|---|---|
| `exposeStack` | `false` | include stacks in 5xx bodies |
| `log` | `console.error` | 5xx only |
| `message` | `"Internal server error"` | body for unhandled 5xx |
| `format` | | reshape the body into your envelope |

`HttpError` keeps its status and message. Errors from other middleware are
honoured too: `err.status` / `err.statusCode` / `err.expose` follow the
`http-errors` convention, so an existing Express 404 stays a 404. Anything else
becomes a generic 500, so internal messages never reach a client by accident.

---

## Dependency injection

Opt-in. `registerControllers` with plain instances stays fully supported — reach for the container when manual wiring gets tedious.

Dependencies are declared with `@Inject`, because without `reflect-metadata` there is no type information to infer from. That's the deliberate trade for zero dependencies: slightly more typing, no magic.

```ts
import { Inject, token, Container } from "structex/di";

const CONFIG = token<Config>("CONFIG");

class Database {
  constructor(@Inject(CONFIG) private readonly config: Config) {}
}

class UserService {
  constructor(@Inject(Database) private readonly db: Database) {}
}
```

### Provider forms

```ts
Database                                              // shorthand: class as its own token
{ provide: CONFIG, useValue: { url: "..." } }         // constant
{ provide: Database, useClass: PostgresDatabase }     // swap implementation
{ provide: CONN, useFactory: async () => connect() }  // async supported
{ provide: CONN, useFactory: (c) => connect(c), inject: [CONFIG] }
{ provide: LEGACY, useExisting: Database }            // alias
```

### Scopes

| Scope | Behavior |
|---|---|
| `singleton` (default) | One instance for the container's lifetime |
| `request` | One instance per request, cached for that request |
| `transient` | A new instance on every resolution |

**Scope bubbles up.** Anything that transitively depends on a request-scoped provider is itself request-scoped, whatever it declared — a controller holding a per-tenant repository is rebuilt per request automatically.

`REQUEST` and `RESPONSE` are built-in request-scoped tokens:

```ts
{
  provide: TENANT_DB,
  useFactory: (req, db) => db.forTenant(req.headers["x-tenant"]),
  inject: [REQUEST, Database],
  scope: "request",
}
```

### Optional and deferred dependencies

```ts
import { optional, forwardRef } from "structex/di";

// undefined instead of throwing when nothing provides LOGGER
{ provide: SERVICE, useFactory: (log) => ..., inject: [optional(LOGGER)] }

// defers reading the token until resolution — fixes declaration order
class A { constructor(@Inject(forwardRef(() => B)) b: B) {} }
```

`forwardRef` solves **declaration order**, not circular construction: if A needs
a fully built B and B needs a fully built A, that is still a cycle and still
throws. `optional` tolerates a missing provider but never hides a cycle or an
error thrown by a provider that does exist.

### Lifecycle

Singletons may implement `onModuleInit()` (awaited at startup, after every container is built) and `onDispose()` (run by `application.close()` in reverse creation order).

**Request-scoped providers are disposed when the response completes**, newest
first — so a per-request transaction or connection is released rather than
leaked. Disposal runs on both `finish` and client abort, and a throwing hook is
logged rather than crashing the process.

---

## Guards and interceptors at every level

Guards run global → module → controller → method; interceptors nest in the same
order, outermost first.

```ts
registerControllers(app, controllers, {
  guards: [authenticated],        // every route
  interceptors: [timing()],
});

defineModule({
  name: "AdminModule",
  guards: [roles("admin")],       // every controller in this module
  controllers: [AdminController],
});
```

---

## Modules

A module groups controllers and providers, and — the actual point — **encapsulates them**. Providers are private unless exported.

```ts
import { defineModule, createApplication } from "structex/di";

const DatabaseModule = defineModule({
  name: "DatabaseModule",
  imports: [ConfigModule],
  providers: [Database],
  exports: [Database],          // only this is visible to importers
});

const UserModule = defineModule({
  name: "UserModule",
  imports: [DatabaseModule],
  providers: [UserService],     // private
  controllers: [UserController],
  prefix: "/users",             // optional, on top of @Controller's prefix
  middleware: [rateLimit()],    // mounted at the module prefix
});

const AppModule = defineModule({
  name: "AppModule",
  imports: [UserModule, OrderModule],
});

const app = express();
app.use(express.json());

const application = await createApplication(app, AppModule, { prefix: "/api" });
printRoutes(application.routes);

app.use(errorHandler);          // still yours to mount
```

`createApplication` is async because factory providers can be. It:

- compiles the module graph, deduplicating shared modules so each is built once
- **eagerly creates every singleton**, so a missing or circular dependency fails at startup rather than on the first request
- resolves each controller — per request if it is transitively request-scoped
- returns `{ routes, containers, modules, resolve, close }`

Errors are `DependencyError` and name the path: `No provider for CONFIG (required by UserService -> Database)`.

### Testing with modules

```ts
const application = await createApplication(express(), AppModule);
const service = await application.resolve(UserService);
await application.close();
```

Swap a real dependency for a fake by overriding its provider in a test module:

```ts
defineModule({
  name: "TestModule",
  imports: [UserModule],
  providers: [{ provide: Database, useValue: fakeDb }],
});
```

---

## API

### Class

| Decorator | Purpose |
|---|---|
| `@Controller(prefix?, ...middleware)` | Marks a controller and sets its path prefix |
| `@UseGuards(...guards)` | Guards for every route on the controller |
| `@UseInterceptors(...interceptors)` | Interceptors for every route (outermost) |
| `@ApiDoc({ tags })` | Default OpenAPI tags |

### Routes

`@Get` `@Post` `@Put` `@Patch` `@Delete` `@Options` `@Head`, each `(path?, ...middleware)`.
`@Sse(path?, ...middleware)` registers a streaming GET route.
`Route(method)` builds a decorator for any other verb.

### Response

| Decorator | Purpose |
|---|---|
| `@HttpCode(status)` | Explicit success status |
| `@Header(name, value)` | Adds a response header (repeatable) |
| `@Redirect(url?, status?)` | Redirect instead of a body |
| `@UseGuards(...guards)` | Guards for this route, after class guards |
| `@UseInterceptors(...i)` | Interceptors for this route |
| `@ApiDoc(doc \| summary)` | OpenAPI enrichment for this operation |

### Parameters

| Decorator | Reads |
|---|---|
| `@Body()` / `@Body("key")` | `req.body` |
| `@Param("id")` | `req.params` |
| `@Query("page")` | `req.query` |
| `@Headers("authorization")` | `req.headers` (key lower-cased) |
| `@Cookies("session")` | `req.cookies` (needs cookie-parser) |
| `@UploadedFile()` / `@UploadedFiles()` | `req.file` / `req.files` (needs multer) |
| `@Ip()` | `req.ip` |
| `@Req()` `@Res()` `@Next()` | Raw Express objects |

Every source decorator also accepts pipes: `@Query("page", toInt, clamp(1, 100))`.

### Built-in pipes

`required` · `defaultTo(v)` · `trim` · `toNumber` · `toInt` · `toBoolean` · `clamp(min, max)` · `oneOf(...values)` · `parseWith(schema)`

`parseWith` adapts anything with a `safeParse` method:

```ts
import { z } from "zod";
import { Body } from "structex";
import { parseWith } from "structex/pipes";

const CreateUser = z.object({ email: z.string().email(), name: z.string().min(1) });
type CreateUserDto = z.infer<typeof CreateUser>;

@Post("/")
create(@Body(parseWith(CreateUser)) dto: CreateUserDto) { ... }
```

Failures throw a `400` carrying `error.flatten()` as `details`.

### Errors

`HttpError` plus `BadRequest` `Unauthorized` `Forbidden` `NotFound` `Conflict` `UnprocessableEntity` `TooManyRequests` `InternalServerError`, and the `isHttpError(err)` type guard.

### Registration

```ts
registerControllers(app, controllers, options?): RouteInfo[]
listRoutes(controllers, { prefix }?): RouteInfo[]   // no mounting, no instantiation
printRoutes(routes, log?): void
scoped(Ctor, (req, res) => instance): ScopedController
createApplication(app, rootModule, options?): Promise<ApplicationRef>
defineModule({ name?, imports?, providers?, controllers?, exports?, prefix?, middleware? })
token<T>(name): InjectionToken<T>
createTestApp(controllers, { express, user?, middleware? }): { app, routes }
toOpenApi(controllers, { info, prefix?, servers?, extra? }): object
respond(body, { status?, headers? }): ResponseEnvelope
```

`app` may be an Express app or a `Router`. `controllers` accepts classes, **instances**, or `scoped()` factories.

`RegisterOptions`: `prefix` · `defaultStatus` · `transform` · `detectDuplicates`

---

## Custom decorators

Parameter decorators are the main extension point:

```ts
import { createParamDecorator, Unauthorized } from "structex";

export const CurrentUser = () =>
  createParamDecorator((req) => {
    if (!req.user) throw Unauthorized();
    return req.user;
  });
```

Guards are plain functions, so they compose:

```ts
const or = (...guards: Guard[]): Guard => async (req, res) => {
  for (const g of guards) {
    try { if (await g(req, res)) return true; } catch { /* next */ }
  }
  throw Forbidden();
};

@Delete("/:id")
@UseGuards(authenticated, or(roles("admin"), owns("id")))
remove(@Param("id") id: string) {}
```

Custom pipes are `(value, meta) => value`:

```ts
const slugify: Pipe<string, string> = (v) => v.toLowerCase().replace(/\s+/g, "-");
```

For behavior around a handler (caching, timing), write an ordinary method decorator that wraps `descriptor.value`. For anything touching raw HTTP, use Express middleware.

---

## Inheritance

Routes declared on a decorated base class are inherited under the derived controller's prefix. Re-declaring the same handler + verb in the derived class replaces the base entry rather than duplicating it.

```ts
@Controller()
abstract class BaseController {
  @Get("/health") health() { return { ok: true }; }
}

@Controller("/users")
class UserController extends BaseController {}   // GET /users/health
```

---

## Bundlers

The `experimentalDecorators` flag must reach whatever performs the TS transform.

**Vitest / Vite**

```ts
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
});
```

**tsup** — reads your `tsconfig.json`, no extra config.

**SWC** — set `jsc.transform.legacyDecorator: true` and `jsc.transform.decoratorMetadata: false`.

`useDefineForClassFields: false` matters: with it on, class fields are defined rather than assigned, which breaks constructor-assigned dependencies on some targets.

---

## Gotchas

- **Route order is source order.** Declare `/me` before `/:id`, or Express matches `:id = "me"`.
- **`@HttpCode(204)` sends no body.** Returning a value from such a handler is silently ignored — that's deliberate, since a 204 with a body is invalid.
- **POST defaults to 201.** Override with `defaultStatus` if that breaks existing clients.
- **Multer types.** `Express.Multer.File` requires `@types/multer` in your project; it isn't a dependency here.
- **No constructor injection.** Pass instances (`new UserController(db)`) — that's the supported pattern.
- **Duplicate registration throws** by default. Pass `{ detectDuplicates: false }` if you deliberately mount the same controller twice on one router.
- **`retry` re-runs pipes too.** Parameter resolution happens inside the interceptor chain, so a retried request re-validates. That's usually what you want, but it means pipes must be side-effect free.
- **`cache` never varies by user** unless you supply a `key`. The default key is method + URL.
- **OpenAPI schemas are not inferred.** Only paths, methods, and path params are derived; bodies and responses come from `@ApiDoc`.
- **Every injected constructor parameter needs `@Inject`.** A gap in the list throws a clear error rather than silently injecting `undefined`.
- **Module middleware is mounted with `app.use(prefix, ...)`,** so it applies to anything under that prefix registered afterwards — not only that module's routes.
- **`createApplication` is async.** Awaiting it is what guarantees async factories and `onModuleInit` complete before the first request.
- **Scope bubbles up silently.** A controller that depends on a request-scoped provider is rebuilt per request; that is correct, but it means the controller is no longer a singleton and shouldn't hold cross-request state.
- **Serialization needs class instances.** Plain objects from a repository or `JSON.parse` have no rules attached and pass through with every field intact.
- **`@Exclude()` is not a security boundary on input.** It shapes responses only; validate and whitelist request bodies separately with pipes.
- **Request-scope disposal is fire-and-forget.** It runs after the response is sent, so a slow `onDispose()` delays nothing but also cannot alter the response.
- **A missing `experimentalDecorators` now throws a clear error** naming the setting, rather than an opaque `Cannot read properties of undefined`.

---

## Scope

Two ways to use it, and you can start with the first and move to the second:

1. **Thin routing layer** — `registerControllers(app, [new UserController(db)])`. Manual wiring, no container, nothing hidden.
2. **Full application** — `createApplication(app, AppModule)`. Modules, DI, scopes, lifecycle hooks.

Serialization, guards, interceptors, and the error handler work identically in both.

The one thing still deliberately absent is **type-inferred OpenAPI schemas and type-inferred injection**, both of which require `reflect-metadata`. That's why `@Inject` is explicit. If you would rather have the reflection-driven ergonomics and a larger ecosystem, [NestJS](https://nestjs.com) is the mature choice and this package doesn't try to replace it.

## License

MIT
