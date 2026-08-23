import { describe, expect, it, vi } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";

import {
  ApiDoc,
  Body,
  Controller,
  Cookies,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  Put,
  Redirect,
  Sse,
  UseInterceptors,
  cache,
  createTestApp,
  envelope,
  formatSseEvent,
  listRoutes,
  registerControllers,
  respond,
  retry,
  scoped,
  timeout,
  timing,
  toOpenApi,
  toOpenApiPath,
  type ExecutionContext,
  type Interceptor,
  type SseEvent,
} from "../src/index.js";

const build = (
  controllers: Parameters<typeof createTestApp>[0],
  options: Partial<Parameters<typeof createTestApp>[1]> = {},
) => createTestApp(controllers, { express, ...options });

/* ------------------------------------------------------------------ *
 * Dynamic status via respond()
 * ------------------------------------------------------------------ */

@Controller("/items")
class ItemController {
  private readonly store = new Set<string>(["existing"]);

  @Put("/:id")
  upsert(@Param("id") id: string) {
    const created = !this.store.has(id);
    this.store.add(id);
    return respond({ id, created }, { status: created ? 201 : 200 });
  }

  @Get("/with-headers")
  headers() {
    return respond({ ok: true }, { headers: { "X-Custom": "yes" } });
  }

  @Get("/override-httpcode")
  @HttpCode(202)
  override() {
    return respond({ ok: true }, { status: 200 });
  }
}

describe("respond() dynamic status", () => {
  it("varies status per request without @Res()", async () => {
    const { app } = build([new ItemController()]);
    expect((await request(app).put("/items/existing")).status).toBe(200);
    expect((await request(app).put("/items/fresh")).status).toBe(201);
  });

  it("sets envelope headers", async () => {
    const { app } = build([ItemController]);
    const res = await request(app).get("/items/with-headers");
    expect(res.headers["x-custom"]).toBe("yes");
    expect(res.body).toEqual({ ok: true });
  });

  it("overrides @HttpCode", async () => {
    const { app } = build([ItemController]);
    expect((await request(app).get("/items/override-httpcode")).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * transform hook
 * ------------------------------------------------------------------ */

@Controller("/wrapped")
class WrappedController {
  @Get("/data")
  data() {
    return { id: 1 };
  }

  @Get("/nothing")
  @HttpCode(204)
  nothing() {
    return { ignored: true };
  }

  @Get("/manual")
  manual(@Body() _b: unknown, ...rest: unknown[]) {
    void rest;
    return undefined;
  }

  @Get("/redirected")
  @Redirect("/wrapped/data")
  redirected() {}
}

describe("transform hook", () => {
  const transform = (result: unknown, ctx: { status: number; path: string }) => ({
    data: result,
    meta: { status: ctx.status, path: ctx.path },
  });

  it("wraps successful JSON bodies", async () => {
    const { app } = build([WrappedController], { transform });
    const res = await request(app).get("/wrapped/data");
    expect(res.body).toEqual({
      data: { id: 1 },
      meta: { status: 200, path: "/wrapped/data" },
    });
  });

  it("is skipped for empty-body statuses", async () => {
    const { app } = build([WrappedController], { transform });
    const res = await request(app).get("/wrapped/nothing");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("is skipped for redirects", async () => {
    const { app } = build([WrappedController], { transform });
    const res = await request(app).get("/wrapped/redirected");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/wrapped/data");
  });

  it("suppresses the body when it returns undefined", async () => {
    const { app } = build([WrappedController], {
      transform: () => undefined,
    });
    const res = await request(app).get("/wrapped/data");
    expect(res.text).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * Interceptors
 * ------------------------------------------------------------------ */

const order: string[] = [];

const trace = (name: string): Interceptor => async (_ctx, next) => {
  order.push(`${name}:before`);
  const result = await next();
  order.push(`${name}:after`);
  return result;
};

@Controller("/intercepted")
@UseInterceptors(trace("class"))
class InterceptedController {
  private calls = 0;

  @Get("/order")
  @UseInterceptors(trace("method"))
  ordered() {
    order.push("handler");
    return { ok: true };
  }

  @Get("/mutate")
  @UseInterceptors(envelope((result) => ({ wrapped: result })))
  mutate() {
    return { id: 1 };
  }

  @Get("/cached")
  @UseInterceptors(cache({ ttl: 10_000 }))
  cached() {
    return { calls: ++this.calls };
  }

  @Get("/slow")
  @UseInterceptors(timeout(20))
  async slow() {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  }

  @Get("/flaky")
  @UseInterceptors(retry({ attempts: 3 }))
  flaky() {
    this.calls++;
    if (this.calls < 3) throw new Error("transient");
    return { calls: this.calls };
  }
}

describe("interceptors", () => {
  it("runs class interceptors outside method interceptors", async () => {
    order.length = 0;
    const { app } = build([new InterceptedController()]);
    await request(app).get("/intercepted/order");
    expect(order).toEqual([
      "class:before",
      "method:before",
      "handler",
      "method:after",
      "class:after",
    ]);
  });

  it("lets an interceptor replace the result", async () => {
    const { app } = build([new InterceptedController()]);
    const res = await request(app).get("/intercepted/mutate");
    expect(res.body).toEqual({ wrapped: { id: 1 } });
  });

  it("caches within the TTL", async () => {
    const { app } = build([new InterceptedController()]);
    const first = await request(app).get("/intercepted/cached");
    const second = await request(app).get("/intercepted/cached");
    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
  });

  it("shares one in-flight call across concurrent requests for a cold key", async () => {
    let calls = 0;

    @Controller("/cache-concurrent")
    class ConcurrentController {
      @Get("/x")
      @UseInterceptors(cache({ ttl: 10_000 }))
      async x() {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { calls };
      }
    }

    const { app } = build([ConcurrentController]);
    const [a, b, c] = await Promise.all([
      request(app).get("/cache-concurrent/x"),
      request(app).get("/cache-concurrent/x"),
      request(app).get("/cache-concurrent/x"),
    ]);

    // All three arrived before the first call resolved, so the handler
    // should have run exactly once, not three times.
    expect(calls).toBe(1);
    expect(a.body).toEqual({ calls: 1 });
    expect(b.body).toEqual({ calls: 1 });
    expect(c.body).toEqual({ calls: 1 });
  });

  it("does not cache a rejection — the next call retries", async () => {
    let calls = 0;

    @Controller("/cache-flaky")
    class CacheFlakyController {
      @Get("/x")
      @UseInterceptors(cache({ ttl: 10_000 }))
      x() {
        calls++;
        if (calls === 1) throw new Error("transient");
        return { calls };
      }
    }

    const { app } = build([CacheFlakyController]);
    const first = await request(app).get("/cache-flaky/x");
    const second = await request(app).get("/cache-flaky/x");

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ calls: 2 });
  });

  it("fails a slow handler with the timeout status", async () => {
    const { app } = build([new InterceptedController()]);
    const res = await request(app).get("/intercepted/slow");
    expect(res.status).toBe(408);
    expect(res.body.message).toContain("timed out");
  });

  it("retries until success", async () => {
    const { app } = build([new InterceptedController()]);
    const res = await request(app).get("/intercepted/flaky");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ calls: 3 });
  });

  it("re-invokes the handler when next() is called twice (enables retry)", async () => {
    let calls = 0;
    const twice: Interceptor = async (_ctx, next) => {
      await next();
      return next();
    };

    @Controller("/twice")
    class TwiceController {
      @Get("/x")
      @UseInterceptors(twice)
      x() {
        return { calls: ++calls };
      }
    }

    const { app } = build([TwiceController]);
    const res = await request(app).get("/twice/x");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ calls: 2 });
  });

  it("passes execution context to interceptors", async () => {
    const seen: ExecutionContext[] = [];
    const capture: Interceptor = async (ctx, next) => {
      seen.push(ctx);
      return next();
    };

    @Controller("/ctx")
    class CtxController {
      @Get("/x")
      @UseInterceptors(capture)
      x() {
        return null;
      }
    }

    const { app } = build([CtxController]);
    await request(app).get("/ctx/x");
    expect(seen[0]).toMatchObject({
      controller: "CtxController",
      handler: "x",
      method: "get",
      path: "/ctx/x",
    });
  });

  it("logs timing without altering the response", async () => {
    const log = vi.fn();

    @Controller("/timed")
    class TimedController {
      @Get("/x")
      @UseInterceptors(timing(log))
      x() {
        return { ok: true };
      }
    }

    const { app } = build([TimedController]);
    const res = await request(app).get("/timed/x");
    expect(res.body).toEqual({ ok: true });
    expect(log).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

@Controller("/go")
class RedirectController {
  @Get("/static")
  @Redirect("/target", 301)
  static_() {}

  @Get("/dynamic")
  @Redirect()
  dynamic(@Param("to") _to: string) {
    return { url: "/computed", status: 307 };
  }

  @Get("/missing")
  @Redirect()
  missing() {}
}

describe("@Redirect", () => {
  it("uses the decorator target and status", async () => {
    const { app } = build([RedirectController]);
    const res = await request(app).get("/go/static");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/target");
  });

  it("lets the handler override url and status", async () => {
    const { app } = build([RedirectController]);
    const res = await request(app).get("/go/dynamic");
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe("/computed");
  });

  it("fails loudly when no url is available", async () => {
    const { app } = build([RedirectController]);
    expect((await request(app).get("/go/missing")).status).toBe(500);
  });
});

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

@Controller("/stream")
class StreamController {
  @Sse("/ticks")
  async *ticks(): AsyncGenerator<SseEvent<{ n: number }>> {
    for (let n = 1; n <= 3; n++) {
      yield { event: "tick", id: String(n), data: { n } };
    }
  }

  @Sse("/plain")
  plain() {
    return [{ data: "one" }, { data: "two" }];
  }

  @Sse("/manual")
  manual(@Param("x") _x: string, ...rest: unknown[]) {
    void rest;
    return undefined;
  }
}

describe("@Sse", () => {
  it("streams events in wire format", async () => {
    const { app } = build([StreamController]);
    const res = await request(app).get("/stream/ticks");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.text).toContain("event: tick");
    expect(res.text).toContain("id: 1");
    expect(res.text).toContain('data: {"n":1}');
    expect(res.text.trim().split("\n\n")).toHaveLength(3);
  });

  it("accepts a synchronous iterable", async () => {
    const { app } = build([StreamController]);
    const res = await request(app).get("/stream/plain");
    expect(res.text).toContain("data: one");
    expect(res.text).toContain("data: two");
  });

  it("marks sse routes in listRoutes", () => {
    const routes = listRoutes([StreamController]);
    expect(routes.every((r) => r.sse)).toBe(true);
    expect(routes.every((r) => r.method === "get")).toBe(true);
  });
});

describe("formatSseEvent", () => {
  it("splits multi-line payloads across data lines", () => {
    expect(formatSseEvent({ data: "a\nb" })).toBe("data: a\ndata: b\n\n");
  });

  it("treats a bare value as data", () => {
    expect(formatSseEvent(42)).toBe("data: 42\n\n");
  });

  it("emits retry", () => {
    expect(formatSseEvent({ data: "x", retry: 5000 })).toContain("retry: 5000");
  });
});

/* ------------------------------------------------------------------ *
 * Scoped (per-request) controllers
 * ------------------------------------------------------------------ */

@Controller("/tenant")
class TenantController {
  constructor(private readonly tenantId: string) {}

  @Get("/who")
  who() {
    return { tenantId: this.tenantId };
  }
}

describe("scoped()", () => {
  it("builds a fresh instance per request", async () => {
    let built = 0;
    const app = express();
    registerControllers(app, [
      scoped(TenantController, (req: Request) => {
        built++;
        return new TenantController(String(req.headers["x-tenant"] ?? "none"));
      }),
    ]);

    const first = await request(app).get("/tenant/who").set("X-Tenant", "acme");
    const second = await request(app).get("/tenant/who").set("X-Tenant", "globex");

    expect(first.body).toEqual({ tenantId: "acme" });
    expect(second.body).toEqual({ tenantId: "globex" });
    expect(built).toBe(2);
  });

  it("supports an async factory", async () => {
    const app = express();
    registerControllers(app, [
      scoped(TenantController, async () => {
        await Promise.resolve();
        return new TenantController("async");
      }),
    ]);
    expect((await request(app).get("/tenant/who")).body).toEqual({
      tenantId: "async",
    });
  });

  it("reads route metadata without calling the factory", () => {
    const factory = vi.fn(() => new TenantController("x"));
    const routes = listRoutes([scoped(TenantController, factory)]);
    expect(factory).not.toHaveBeenCalled();
    expect(routes.map((r) => r.path)).toEqual(["/tenant/who"]);
  });
});

/* ------------------------------------------------------------------ *
 * Duplicate detection
 * ------------------------------------------------------------------ */

@Controller("/dupe")
class DupeController {
  @Get("/x")
  x() {
    return null;
  }
}

describe("duplicate detection", () => {
  it("throws when the same route is registered twice on one router", () => {
    const app = express();
    registerControllers(app, [DupeController]);
    expect(() => registerControllers(app, [DupeController])).toThrow(
      /already registered/,
    );
  });

  it("can be disabled", () => {
    const app = express();
    registerControllers(app, [DupeController]);
    expect(() =>
      registerControllers(app, [DupeController], { detectDuplicates: false }),
    ).not.toThrow();
  });

  it("allows the same controller on different routers", () => {
    expect(() => {
      registerControllers(express(), [DupeController]);
      registerControllers(express(), [DupeController]);
    }).not.toThrow();
  });

  it("allows the same controller under different prefixes", () => {
    const app = express();
    registerControllers(app, [DupeController], { prefix: "/v1" });
    expect(() =>
      registerControllers(app, [DupeController], { prefix: "/v2" }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Cookies and Ip
 * ------------------------------------------------------------------ */

@Controller("/req-info")
class ReqInfoController {
  @Get("/cookie")
  cookie(@Cookies("session") session: string | undefined) {
    return { session: session ?? null };
  }

  @Get("/ip")
  ip(@Ip() ip: string | undefined) {
    return { hasIp: typeof ip === "string" && ip.length > 0 };
  }
}

describe("@Cookies and @Ip", () => {
  it("returns null when cookie-parser is absent", async () => {
    const { app } = build([ReqInfoController]);
    expect((await request(app).get("/req-info/cookie")).body).toEqual({
      session: null,
    });
  });

  it("reads a parsed cookie", async () => {
    const { app } = build([ReqInfoController], {
      middleware: [
        (req: Request, _res: Response, next) => {
          (req as Request & { cookies: Record<string, string> }).cookies = {
            session: "abc",
          };
          next();
        },
      ],
    });
    expect((await request(app).get("/req-info/cookie")).body).toEqual({
      session: "abc",
    });
  });

  it("injects the client ip", async () => {
    const { app } = build([ReqInfoController]);
    expect((await request(app).get("/req-info/ip")).body).toEqual({
      hasIp: true,
    });
  });
});

/* ------------------------------------------------------------------ *
 * createTestApp
 * ------------------------------------------------------------------ */

@Controller("/probe")
class ProbeController {
  @Get("/me")
  me(@Body() _body: unknown, ...rest: unknown[]) {
    void rest;
    return { ok: true };
  }

  @Post("/echo")
  echo(@Body() body: unknown) {
    return body;
  }

  @Get("/boom")
  boom(): never {
    throw new Error("kaboom");
  }
}

describe("createTestApp", () => {
  it("mounts controllers and returns the route table", async () => {
    const { app, routes } = build([ProbeController]);
    expect(routes.map((r) => r.path)).toContain("/probe/me");
    expect((await request(app).get("/probe/me")).status).toBe(200);
  });

  it("parses JSON bodies by default", async () => {
    const { app } = build([ProbeController]);
    const res = await request(app).post("/probe/echo").send({ a: 1 });
    expect(res.body).toEqual({ a: 1 });
  });

  it("injects a fake user", async () => {
    let seen: unknown;

    @Controller("/who")
    class WhoController {
      @Get("/")
      who(@Body() _b: unknown, ...rest: unknown[]) {
        void rest;
        return null;
      }
    }

    const { app } = build([WhoController], {
      user: { id: "u_1" },
      middleware: [
        (req: Request, _res: Response, next) => {
          seen = (req as Request & { user?: unknown }).user;
          next();
        },
      ],
    });
    await request(app).get("/who");
    expect(seen).toEqual({ id: "u_1" });
  });

  it("installs a default error handler", async () => {
    const { app } = build([ProbeController]);
    const res = await request(app).get("/probe/boom");
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal server error");
  });
});

/* ------------------------------------------------------------------ *
 * OpenAPI
 * ------------------------------------------------------------------ */

@Controller("/docs-users")
@ApiDoc({ tags: ["Users"] })
class DocumentedController {
  @Get("/:id/posts/:postId")
  @ApiDoc({ summary: "Get a post", responses: { "200": { description: "ok" } } })
  find(@Param("id") _id: string) {
    return null;
  }

  @Post("/")
  @ApiDoc("Create a user")
  create() {
    return null;
  }

  @Sse("/live")
  live() {
    return [];
  }
}

describe("toOpenApi", () => {
  const spec = toOpenApi([DocumentedController], {
    info: { title: "Test API", version: "1.0.0" },
    prefix: "/api",
  }) as any;

  it("converts express params to OpenAPI templates", () => {
    expect(toOpenApiPath("/users/:id/posts/:postId")).toEqual({
      path: "/users/{id}/posts/{postId}",
      params: ["id", "postId"],
    });
  });

  it("emits path params as required string parameters", () => {
    const op = spec.paths["/api/docs-users/{id}/posts/{postId}"].get;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "postId", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(op.summary).toBe("Get a post");
  });

  it("inherits class tags and defaults the 201 response for POST", () => {
    const op = spec.paths["/api/docs-users"].post;
    expect(op.tags).toEqual(["Users"]);
    expect(op.summary).toBe("Create a user");
    expect(op.responses["201"]).toBeDefined();
  });

  it("omits sse routes", () => {
    expect(spec.paths["/api/docs-users/live"]).toBeUndefined();
  });

  it("includes info and version", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toEqual({ title: "Test API", version: "1.0.0" });
  });
});
