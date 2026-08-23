import { describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";

import {
  Controller,
  Exclude,
  Expose,
  Get,
  Inject,
  Param,
  REQUEST,
  Transform,
  UseGuards,
  Container,
  DependencyError,
  createApplication,
  createErrorHandler,
  createRequestScope,
  defineModule,
  disposeRequestScope,
  forwardRef,
  optional,
  registerControllers,
  serialize,
  token,
  type Guard,
  type Interceptor,
  type OnDispose,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

class User {
  id = "u_1";
  email = "ada@example.com";

  @Exclude()
  passwordHash = "$2b$10$secret";

  @Expose({ name: "displayName" })
  name = "Ada";

  @Expose({ groups: ["admin"] })
  internalNote = "flagged";

  @Transform((value) => (value as Date).toISOString().slice(0, 10))
  createdAt = new Date("2024-01-15T10:30:00Z");
}

describe("serialize", () => {
  it("omits excluded fields", () => {
    const output = serialize(new User()) as Record<string, unknown>;
    expect(output.passwordHash).toBeUndefined();
    expect(output.id).toBe("u_1");
  });

  it("renames exposed fields", () => {
    const output = serialize(new User()) as Record<string, unknown>;
    expect(output.displayName).toBe("Ada");
    expect(output.name).toBeUndefined();
  });

  it("hides group-restricted fields unless the group is active", () => {
    expect(
      (serialize(new User()) as Record<string, unknown>).internalNote,
    ).toBeUndefined();
    expect(
      (serialize(new User(), { groups: ["admin"] }) as Record<string, unknown>)
        .internalNote,
    ).toBe("flagged");
  });

  it("applies transforms", () => {
    const output = serialize(new User()) as Record<string, unknown>;
    expect(output.createdAt).toBe("2024-01-15");
  });

  it("recurses through arrays and nested instances", () => {
    class Team {
      name = "core";
      members = [new User()];
      lead = new User();
    }
    const output = serialize(new Team()) as any;
    expect(output.members[0].passwordHash).toBeUndefined();
    expect(output.lead.displayName).toBe("Ada");
  });

  it("leaves plain objects and primitives untouched", () => {
    expect(serialize({ a: 1, passwordHash: "kept" })).toEqual({
      a: 1,
      passwordHash: "kept",
    });
    expect(serialize("x")).toBe("x");
    expect(serialize(null)).toBe(null);
    expect(serialize(42)).toBe(42);
  });

  it("passes Dates through when not transformed", () => {
    class Row {
      at = new Date("2024-01-01T00:00:00Z");
    }
    expect((serialize(new Row()) as any).at).toBeInstanceOf(Date);
  });

  it("survives circular references", () => {
    class Node {
      name = "a";
      self?: Node;
    }
    const node = new Node();
    node.self = node;
    expect(() => serialize(node)).not.toThrow();
  });

  it("inherits rules from a decorated base class", () => {
    class Base {
      @Exclude()
      secret = "hidden";
    }
    class Derived extends Base {
      visible = "shown";
    }
    const output = serialize(new Derived()) as Record<string, unknown>;
    expect(output.secret).toBeUndefined();
    expect(output.visible).toBe("shown");
  });
});

describe("serialization in responses", () => {
  @Controller("/users")
  class UserController {
    @Get("/:id")
    findOne(@Param("id") _id: string) {
      return new User();
    }

    @Get("/")
    list() {
      return [new User()];
    }
  }

  function build(options = {}) {
    const app = express();
    registerControllers(app, [UserController], options);
    return app;
  }

  it("strips excluded fields from real responses", async () => {
    const res = await request(build()).get("/users/u_1");
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.displayName).toBe("Ada");
  });

  it("applies to arrays", async () => {
    const res = await request(build()).get("/users");
    expect(res.body[0].passwordHash).toBeUndefined();
  });

  it("respects request-derived groups", async () => {
    const app = build({
      serialize: {
        groups: (req: Request) =>
          req.headers["x-role"] === "admin" ? ["admin"] : [],
      },
    });
    const asUser = await request(app).get("/users/u_1");
    const asAdmin = await request(app).get("/users/u_1").set("X-Role", "admin");
    expect(asUser.body.internalNote).toBeUndefined();
    expect(asAdmin.body.internalNote).toBe("flagged");
  });

  it("can be disabled", async () => {
    const res = await request(build({ serialize: false })).get("/users/u_1");
    expect(res.body.passwordHash).toBeDefined();
  });

  it("runs before the transform hook", async () => {
    const app = build({
      transform: (result: unknown) => ({ data: result }),
    });
    const res = await request(app).get("/users/u_1");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.displayName).toBe("Ada");
  });
});

/* ------------------------------------------------------------------ *
 * Optional dependencies
 * ------------------------------------------------------------------ */

const LOGGER = token<{ log: (m: string) => void }>("LOGGER");
const MISSING = token<string>("MISSING");

describe("optional()", () => {
  it("injects undefined when no provider exists", async () => {
    const SERVICE = token<{ logger: unknown }>("SERVICE");
    const c = new Container("test", [
      {
        provide: SERVICE,
        useFactory: (logger: unknown) => ({ logger }),
        inject: [optional(LOGGER)],
      },
    ]);
    expect((await c.resolve(SERVICE)).logger).toBeUndefined();
  });

  it("injects the real provider when present", async () => {
    const SERVICE = token<{ logger: unknown }>("SERVICE");
    const logger = { log: () => {} };
    const c = new Container("test", [
      { provide: LOGGER, useValue: logger },
      {
        provide: SERVICE,
        useFactory: (l: unknown) => ({ logger: l }),
        inject: [optional(LOGGER)],
      },
    ]);
    expect((await c.resolve(SERVICE)).logger).toBe(logger);
  });

  it("works with @Inject on a constructor", async () => {
    class Service {
      constructor(@Inject(optional(MISSING)) readonly value: string | undefined) {}
    }
    const c = new Container("test", [Service]);
    expect((await c.resolve(Service)).value).toBeUndefined();
  });

  it("does not swallow errors thrown by a provider that exists", async () => {
    const BROKEN = token<string>("BROKEN");
    const SERVICE = token<string>("SERVICE");
    const c = new Container("test", [
      {
        provide: BROKEN,
        useFactory: () => {
          throw new Error("boom");
        },
      },
      {
        provide: SERVICE,
        useFactory: (v: string) => v,
        inject: [optional(BROKEN)],
      },
    ]);
    await expect(c.resolve(SERVICE)).rejects.toThrow(/boom/);
  });
});

/* ------------------------------------------------------------------ *
 * forwardRef
 * ------------------------------------------------------------------ */

describe("forwardRef()", () => {
  it("resolves a token declared later in the file", async () => {
    class Early {
      constructor(@Inject(forwardRef(() => Late)) readonly late: unknown) {}
    }
    class Late {
      name = "late";
    }

    const c = new Container("test", [Early, Late]);
    const early = await c.resolve(Early);
    expect(early.late).toBeInstanceOf(Late);
  });

  it("still reports a genuine cycle rather than hanging", async () => {
    const A = token<unknown>("A");
    const B = token<unknown>("B");
    const c = new Container("test", [
      { provide: A, useFactory: (b: unknown) => ({ b }), inject: [forwardRef(() => B)] },
      { provide: B, useFactory: (a: unknown) => ({ a }), inject: [forwardRef(() => A)] },
    ]);
    await expect(c.resolve(A)).rejects.toThrow(/Circular dependency/);
  });

  it("composes with optional()", async () => {
    const SERVICE = token<{ dep: unknown }>("SERVICE");
    const c = new Container("test", [
      {
        provide: SERVICE,
        useFactory: (dep: unknown) => ({ dep }),
        inject: [optional(forwardRef(() => MISSING))],
      },
    ]);
    expect((await c.resolve(SERVICE)).dep).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Request-scope disposal
 * ------------------------------------------------------------------ */

describe("request scope disposal", () => {
  it("disposes instances newest first", async () => {
    const events: string[] = [];

    class First implements OnDispose {
      onDispose() {
        events.push("first");
      }
    }
    class Second implements OnDispose {
      constructor(@Inject(First) readonly first: First) {}
      onDispose() {
        events.push("second");
      }
    }

    const c = new Container("test", [
      { provide: First, useClass: First, scope: "request" },
      { provide: Second, useClass: Second, scope: "request" },
    ]);
    const scope = createRequestScope({} as Request, {} as never);
    await c.resolve(Second, scope);

    await disposeRequestScope(scope);
    expect(events).toEqual(["second", "first"]);
  });

  it("keeps going when a hook throws", async () => {
    const onError = vi.fn();
    class Bad implements OnDispose {
      onDispose() {
        throw new Error("nope");
      }
    }
    const c = new Container("test", [
      { provide: Bad, useClass: Bad, scope: "request" },
    ]);
    const scope = createRequestScope({} as Request, {} as never);
    await c.resolve(Bad, scope);

    await expect(disposeRequestScope(scope, onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("disposes after each request in a real app", async () => {
    const disposed: string[] = [];

    const TX = token<{ id: string }>("TX");

    class Transaction implements OnDispose {
      static counter = 0;
      readonly id = `tx_${++Transaction.counter}`;
      onDispose() {
        disposed.push(this.id);
      }
    }

    @Controller("/tx")
    class TxController {
      constructor(@Inject(TX) private readonly tx: { id: string }) {}

      @Get("/")
      current() {
        return { id: this.tx.id };
      }
    }

    const app = express();
    await createApplication(
      app,
      defineModule({
        name: "TxModule",
        providers: [
          {
            provide: TX,
            useFactory: (_req: Request) => new Transaction(),
            inject: [REQUEST],
            scope: "request",
          },
        ],
        controllers: [TxController],
      }),
    );

    const first = await request(app).get("/tx");
    const second = await request(app).get("/tx");

    // Give the 'finish' listener a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(first.body.id).not.toBe(second.body.id);
    expect(disposed).toEqual([first.body.id, second.body.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Global and module guards / interceptors
 * ------------------------------------------------------------------ */

describe("global and module guards", () => {
  const order: string[] = [];

  const guard = (name: string, pass = true): Guard => () => {
    order.push(name);
    return pass;
  };

  const trace = (name: string): Interceptor => async (_ctx, next) => {
    order.push(`${name}:in`);
    const result = await next();
    order.push(`${name}:out`);
    return result;
  };

  it("runs global, then controller, then method guards", async () => {
    order.length = 0;

    @Controller("/g")
    @UseGuards(guard("controller"))
    class GuardedController {
      @Get("/")
      @UseGuards(guard("method"))
      index() {
        return { ok: true };
      }
    }

    const app = express();
    registerControllers(app, [GuardedController], {
      guards: [guard("global")],
    });

    await request(app).get("/g");
    expect(order).toEqual(["global", "controller", "method"]);
  });

  it("short-circuits at the global guard with 403", async () => {
    @Controller("/blocked")
    class BlockedController {
      @Get("/")
      index() {
        return { ok: true };
      }
    }

    const app = express();
    registerControllers(app, [BlockedController], {
      guards: [guard("deny", false)],
    });
    app.use(createErrorHandler({ log: () => {} }));

    expect((await request(app).get("/blocked")).status).toBe(403);
  });

  it("nests global interceptors outside controller ones", async () => {
    order.length = 0;

    @Controller("/i")
    class InterceptedController {
      @Get("/")
      index() {
        order.push("handler");
        return { ok: true };
      }
    }

    const app = express();
    registerControllers(app, [InterceptedController], {
      interceptors: [trace("global")],
    });

    await request(app).get("/i");
    expect(order).toEqual(["global:in", "handler", "global:out"]);
  });

  it("applies module guards to that module's controllers", async () => {
    @Controller("/m")
    class ModuleController {
      @Get("/")
      index() {
        return { ok: true };
      }
    }

    const app = express();
    await createApplication(
      app,
      defineModule({
        name: "GuardedModule",
        guards: [() => false],
        controllers: [ModuleController],
      }),
    );
    app.use(createErrorHandler({ log: () => {} }));

    expect((await request(app).get("/m")).status).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * createErrorHandler
 * ------------------------------------------------------------------ */

describe("createErrorHandler", () => {
  @Controller("/err")
  class ErrorController {
    @Get("/known")
    known() {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }

    @Get("/unknown")
    unknown(): never {
      throw new Error("internal detail that must not leak");
    }
  }

  function build(options = {}) {
    const app = express();
    registerControllers(app, [ErrorController]);
    app.use(createErrorHandler({ log: () => {}, ...options }));
    return app;
  }

  it("hides internal messages behind a generic 500", async () => {
    const res = await request(build()).get("/err/unknown");
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("internal detail");
  });

  it("omits stack traces by default", async () => {
    expect((await request(build()).get("/err/unknown")).body.stack).toBeUndefined();
  });

  it("includes stacks when explicitly enabled", async () => {
    const res = await request(build({ exposeStack: true })).get("/err/unknown");
    expect(res.body.stack).toContain("Error");
  });

  it("logs only 5xx", async () => {
    const log = vi.fn();
    await request(build({ log })).get("/err/known");
    expect(log).not.toHaveBeenCalled();
    await request(build({ log })).get("/err/unknown");
    expect(log).toHaveBeenCalledOnce();
  });

  it("supports a custom envelope", async () => {
    const app = build({
      format: (body: unknown, ctx: { status: number }) => ({
        error: body,
        status: ctx.status,
      }),
    });
    const res = await request(app).get("/err/unknown");
    expect(res.body).toEqual({
      error: { message: "Internal server error" },
      status: 500,
    });
  });

  it("honours err.status from other middleware (http-errors convention)", async () => {
    const res = await request(build()).get("/err/known");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Not Found");
  });

  it("delegates instead of writing twice when headers were already sent", () => {
    const handler = createErrorHandler({ log: () => {} });
    const next = vi.fn();
    const status = vi.fn();
    const err = new Error("late failure");

    handler(
      err,
      {} as never,
      { headersSent: true, status } as never,
      next as never,
    );

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Regression: DependencyError type is preserved
 * ------------------------------------------------------------------ */

it("still throws DependencyError for a genuinely missing provider", async () => {
  const c = new Container("test", [
    { provide: token<string>("X"), useFactory: (v: string) => v, inject: [MISSING] },
  ]);
  await expect(c.resolve(token<string>("X"))).rejects.toBeInstanceOf(
    DependencyError,
  );
});
