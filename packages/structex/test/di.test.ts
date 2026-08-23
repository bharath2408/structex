import { describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";

import {
  Container,
  Controller,
  DependencyError,
  Get,
  Inject,
  Param,
  REQUEST,
  createApplication,
  createRequestScope,
  defineModule,
  token,
  type OnDispose,
  type OnModuleInit,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * Container basics
 * ------------------------------------------------------------------ */

const CONFIG = token<{ url: string }>("CONFIG");

class Database {
  constructor(@Inject(CONFIG) readonly config: { url: string }) {}
  query() {
    return `rows from ${this.config.url}`;
  }
}

class UserService {
  constructor(@Inject(Database) readonly db: Database) {}
  list() {
    return this.db.query();
  }
}

describe("Container", () => {
  it("resolves a class graph through @Inject", async () => {
    const c = new Container("test", [
      { provide: CONFIG, useValue: { url: "postgres://x" } },
      Database,
      UserService,
    ]);
    const service = await c.resolve(UserService);
    expect(service.list()).toBe("rows from postgres://x");
  });

  it("returns the same singleton instance", async () => {
    const c = new Container("test", [
      { provide: CONFIG, useValue: { url: "x" } },
      Database,
    ]);
    expect(await c.resolve(Database)).toBe(await c.resolve(Database));
  });

  it("builds a new instance for transient scope", async () => {
    class Thing {}
    const c = new Container("test", [
      { provide: Thing, useClass: Thing, scope: "transient" },
    ]);
    expect(await c.resolve(Thing)).not.toBe(await c.resolve(Thing));
  });

  it("supports async factories", async () => {
    const CONN = token<string>("CONN");
    const c = new Container("test", [
      {
        provide: CONN,
        useFactory: async () => {
          await Promise.resolve();
          return "connected";
        },
      },
    ]);
    expect(await c.resolve(CONN)).toBe("connected");
  });

  it("supports useExisting aliases", async () => {
    const ALIAS = token<Database>("ALIAS");
    const c = new Container("test", [
      { provide: CONFIG, useValue: { url: "x" } },
      Database,
      { provide: ALIAS, useExisting: Database },
    ]);
    expect(await c.resolve(ALIAS)).toBe(await c.resolve(Database));
  });

  it("names the missing token and its dependent", async () => {
    const c = new Container("test", [Database, UserService]);
    await expect(c.resolve(UserService)).rejects.toThrow(
      /No provider for CONFIG.*required by UserService -> Database/s,
    );
  });

  it("detects circular dependencies with the full path", async () => {
    const A = token<any>("A");
    const B = token<any>("B");
    const c = new Container("test", [
      { provide: A, useFactory: (b: unknown) => ({ b }), inject: [B] },
      { provide: B, useFactory: (a: unknown) => ({ a }), inject: [A] },
    ]);
    await expect(c.resolve(A)).rejects.toThrow(/Circular dependency: A -> B -> A/);
  });

  it("rejects request-scoped providers at boot", async () => {
    const T = token<string>("T");
    const c = new Container("test", [
      { provide: T, useFactory: () => "x", scope: "request" },
    ]);
    await expect(c.resolve(T)).rejects.toThrow(/cannot be resolved at startup/);
  });

  it("caches request-scoped providers within one request", async () => {
    const T = token<object>("T");
    const c = new Container("test", [
      { provide: T, useFactory: () => ({}), scope: "request" },
    ]);
    const scope = createRequestScope({} as Request, {} as never);
    expect(await c.resolve(T, scope)).toBe(await c.resolve(T, scope));

    const other = createRequestScope({} as Request, {} as never);
    expect(await c.resolve(T, other)).not.toBe(await c.resolve(T, scope));
  });

  it("injects REQUEST into request-scoped providers", async () => {
    const TENANT = token<string>("TENANT");
    const c = new Container("test", [
      {
        provide: TENANT,
        useFactory: (req: Request) => String(req.headers["x-tenant"]),
        inject: [REQUEST],
        scope: "request",
      },
    ]);
    const scope = createRequestScope(
      { headers: { "x-tenant": "acme" } } as unknown as Request,
      {} as never,
    );
    expect(await c.resolve(TENANT, scope)).toBe("acme");
  });

  it("marks transitive request-scoped dependencies", () => {
    const SCOPED = token<string>("SCOPED");
    class Wrapper {
      constructor(@Inject(SCOPED) readonly value: string) {}
    }
    const c = new Container("test", [
      { provide: SCOPED, useFactory: () => "x", scope: "request" },
      Wrapper,
    ]);
    expect(c.isRequestScoped(Wrapper)).toBe(true);
    expect(c.isRequestScoped(SCOPED)).toBe(true);
  });

  it("does not cache a singleton that transitively needs request data", async () => {
    const TENANT = token<string>("TENANT");
    class Repo {
      constructor(@Inject(TENANT) readonly tenant: string) {}
    }
    const c = new Container("test", [
      {
        provide: TENANT,
        useFactory: (req: Request) => String(req.headers["x-tenant"]),
        inject: [REQUEST],
        scope: "request",
      },
      Repo, // declared singleton, but must behave as request-scoped
    ]);

    const first = await c.resolve(
      Repo,
      createRequestScope(
        { headers: { "x-tenant": "a" } } as unknown as Request,
        {} as never,
      ),
    );
    const second = await c.resolve(
      Repo,
      createRequestScope(
        { headers: { "x-tenant": "b" } } as unknown as Request,
        {} as never,
      ),
    );

    expect(first.tenant).toBe("a");
    expect(second.tenant).toBe("b");
    expect(first).not.toBe(second);
  });

  it("reports an un-annotated constructor parameter", async () => {
    class Broken {
      constructor(
        _first: unknown,
        @Inject(CONFIG) _second: { url: string },
      ) {}
    }
    const c = new Container("test", [
      { provide: CONFIG, useValue: { url: "x" } },
      Broken,
    ]);
    await expect(c.resolve(Broken)).rejects.toThrow(/without @Inject\(\)/);
  });
});

/* ------------------------------------------------------------------ *
 * Module encapsulation
 * ------------------------------------------------------------------ */

const SECRET = token<string>("SECRET");
const SHARED = token<string>("SHARED");

const CoreModule = defineModule({
  name: "CoreModule",
  providers: [
    { provide: SECRET, useValue: "private" },
    { provide: SHARED, useValue: "public" },
  ],
  exports: [SHARED],
});

describe("module encapsulation", () => {
  it("exposes exported providers to importers", async () => {
    class Consumer {
      constructor(@Inject(SHARED) readonly shared: string) {}
    }
    const app = express();
    const application = await createApplication(
      app,
      defineModule({
        name: "AppModule",
        imports: [CoreModule],
        providers: [Consumer],
      }),
    );
    expect((await application.resolve(Consumer)).shared).toBe("public");
  });

  it("hides providers that are not exported", async () => {
    class Sneaky {
      constructor(@Inject(SECRET) readonly secret: string) {}
    }
    await expect(
      createApplication(
        express(),
        defineModule({
          name: "AppModule",
          imports: [CoreModule],
          providers: [Sneaky],
        }),
      ),
    ).rejects.toThrow(/No provider for SECRET/);
  });

  it("instantiates a shared module once", async () => {
    let built = 0;
    const COUNTER = token<number>("COUNTER");
    const Shared = defineModule({
      name: "Shared",
      providers: [{ provide: COUNTER, useFactory: () => ++built }],
      exports: [COUNTER],
    });
    const A = defineModule({ name: "A", imports: [Shared], exports: [COUNTER] });
    const B = defineModule({ name: "B", imports: [Shared], exports: [COUNTER] });

    await createApplication(
      express(),
      defineModule({ name: "Root", imports: [A, B] }),
    );
    expect(built).toBe(1);
  });

  it("detects circular module imports", async () => {
    const First = defineModule({ name: "First" });
    const Second = defineModule({ name: "Second", imports: [First] });
    (First.definition as { imports?: unknown[] }).imports = [Second];

    await expect(
      createApplication(express(), defineModule({ name: "Root", imports: [First] })),
    ).rejects.toThrow(/Circular module imports/);
  });

  it("rejects a non-module in imports", async () => {
    await expect(
      createApplication(
        express(),
        defineModule({ name: "Root", imports: [{} as never] }),
      ),
    ).rejects.toThrow(/not a module/);
  });
});

/* ------------------------------------------------------------------ *
 * Controllers with injected dependencies
 * ------------------------------------------------------------------ */

const GREETING = token<string>("GREETING");

@Controller("/hello")
class HelloController {
  constructor(@Inject(GREETING) private readonly greeting: string) {}

  @Get("/:name")
  greet(@Param("name") name: string) {
    return { message: `${this.greeting}, ${name}` };
  }
}

describe("createApplication", () => {
  it("injects controller dependencies and mounts routes", async () => {
    const app = express();
    const application = await createApplication(
      app,
      defineModule({
        name: "AppModule",
        providers: [{ provide: GREETING, useValue: "Hi" }],
        controllers: [HelloController],
      }),
      { prefix: "/api" },
    );

    expect(application.routes.map((r) => r.path)).toEqual(["/api/hello/:name"]);
    const res = await request(app).get("/api/hello/Ada");
    expect(res.body).toEqual({ message: "Hi, Ada" });
  });

  it("applies module prefix and middleware", async () => {
    const app = express();
    await createApplication(
      app,
      defineModule({
        name: "AppModule",
        prefix: "/v2",
        middleware: [
          (_req, res, next) => {
            res.set("X-Module", "yes");
            next();
          },
        ],
        providers: [{ provide: GREETING, useValue: "Yo" }],
        controllers: [HelloController],
      }),
    );
    const res = await request(app).get("/v2/hello/Bob");
    expect(res.headers["x-module"]).toBe("yes");
    expect(res.body).toEqual({ message: "Yo, Bob" });
  });

  it("builds a request-scoped controller per request", async () => {
    const TENANT = token<string>("TENANT");

    @Controller("/tenant")
    class TenantController {
      constructor(@Inject(TENANT) private readonly tenant: string) {}

      @Get("/who")
      who() {
        return { tenant: this.tenant };
      }
    }

    const app = express();
    await createApplication(
      app,
      defineModule({
        name: "TenantModule",
        providers: [
          {
            provide: TENANT,
            useFactory: (req: Request) => String(req.headers["x-tenant"] ?? "none"),
            inject: [REQUEST],
            scope: "request",
          },
        ],
        controllers: [TenantController],
      }),
    );

    const first = await request(app).get("/tenant/who").set("X-Tenant", "acme");
    const second = await request(app).get("/tenant/who").set("X-Tenant", "globex");
    expect(first.body).toEqual({ tenant: "acme" });
    expect(second.body).toEqual({ tenant: "globex" });
  });

  it("fails at startup, not first request, on a missing dependency", async () => {
    await expect(
      createApplication(
        express(),
        defineModule({ name: "Broken", controllers: [HelloController] }),
      ),
    ).rejects.toThrow(/No provider for GREETING/);
  });

  it("runs onModuleInit and onDispose in order", async () => {
    const events: string[] = [];

    class First implements OnModuleInit, OnDispose {
      onModuleInit() {
        events.push("init:first");
      }
      onDispose() {
        events.push("dispose:first");
      }
    }
    class Second implements OnModuleInit, OnDispose {
      constructor(@Inject(First) readonly first: First) {}
      onModuleInit() {
        events.push("init:second");
      }
      onDispose() {
        events.push("dispose:second");
      }
    }

    const application = await createApplication(
      express(),
      defineModule({ name: "LifecycleModule", providers: [First, Second] }),
    );

    expect(events).toEqual(["init:first", "init:second"]);
    await application.close();
    expect(events).toEqual([
      "init:first",
      "init:second",
      "dispose:second",
      "dispose:first",
    ]);
  });

  it("awaits async factories before mounting", async () => {
    const CONN = token<string>("CONN");
    const factory = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "ready";
    });

    const application = await createApplication(
      express(),
      defineModule({
        name: "AsyncModule",
        providers: [{ provide: CONN, useFactory: factory }],
      }),
    );
    expect(await application.resolve(CONN)).toBe("ready");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("exposes per-module containers", async () => {
    const application = await createApplication(
      express(),
      defineModule({ name: "Root", imports: [CoreModule] }),
    );
    expect(application.modules).toEqual(["CoreModule", "Root"]);
    expect(application.containers.get("CoreModule")).toBeInstanceOf(Container);
  });

  it("lets a module override a controller provider explicitly", async () => {
    const app = express();
    await createApplication(
      app,
      defineModule({
        name: "OverrideModule",
        providers: [
          { provide: GREETING, useValue: "unused" },
          {
            provide: HelloController,
            useFactory: () => new HelloController("Custom"),
          },
        ],
        controllers: [HelloController],
      }),
    );
    expect((await request(app).get("/hello/X")).body).toEqual({
      message: "Custom, X",
    });
  });

  it("surfaces DependencyError as its own type", async () => {
    const error = await createApplication(
      express(),
      defineModule({ name: "Broken", controllers: [HelloController] }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DependencyError);
  });
});
