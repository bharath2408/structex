import { describe, expect, it } from "vitest";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import request from "supertest";

import {
  Body,
  Controller,
  Delete,
  Forbidden,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFound,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  clamp,
  createParamDecorator,
  isHttpError,
  listRoutes,
  registerControllers,
  toInt,
  trim,
  type ControllerInput,
  type Guard,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

interface AuthUser {
  id: string;
  role: "admin" | "user";
}

const CurrentUser = () =>
  createParamDecorator((req) => (req as Request & { user?: AuthUser }).user);

const attachUser =
  (user: AuthUser | undefined): RequestHandler =>
  (req, _res, next) => {
    (req as Request & { user?: AuthUser }).user = user;
    next();
  };

const authenticated: Guard = (req) =>
  Boolean((req as Request & { user?: AuthUser }).user);

const roles =
  (...allowed: AuthUser["role"][]): Guard =>
  (req) => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) return false;
    if (!allowed.includes(user.role)) {
      throw Forbidden(`Requires one of: ${allowed.join(", ")}`);
    }
    return true;
  };

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = isHttpError(err) ? err.status : 500;
  res.status(status).json({
    message: status === 500 ? "Internal server error" : err.message,
    ...(isHttpError(err) && err.details !== undefined
      ? { details: err.details }
      : {}),
  });
};

function makeApp(
  controllers: ControllerInput[],
  opts: { user?: AuthUser; prefix?: string } = {},
): Express {
  const app = express();
  app.use(express.json());
  app.use(attachUser(opts.user));
  registerControllers(app, controllers, { prefix: opts.prefix });
  app.use(errorHandler);
  return app;
}

/* ------------------------------------------------------------------ *
 * Routing + params + status codes
 * ------------------------------------------------------------------ */

@Controller("/users")
class UserController {
  constructor(private readonly seed: string = "default") {}

  @Get("/list")
  list(
    @Query("page", toInt, clamp(1, 100)) page: number | undefined,
    @Query("q", trim) q: string | undefined,
  ) {
    return { page: page ?? 1, q: q ?? "", seed: this.seed };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    if (id === "missing") throw NotFound(`User ${id} not found`);
    return { id };
  }

  @Post("/")
  @Header("X-Resource", "user")
  create(@Body() dto: { name: string }, @Body("name") name: string) {
    return { created: dto.name, alsoName: name };
  }

  @Delete("/:id")
  @HttpCode(204)
  remove(@Param("id") _id: string) {
    return { ignored: true };
  }

  @Get("/raw/manual")
  manual(@Res() res: Response) {
    res.status(418).type("text/plain").send("teapot");
  }

  @Get("/raw/echo")
  echo(@Req() req: Request, @Headers("x-trace") trace: string | undefined) {
    return { path: req.path, trace: trace ?? null };
  }
}

describe("routing and parameters", () => {
  it("resolves path params", async () => {
    const res = await request(makeApp([UserController])).get("/users/u_1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "u_1" });
  });

  it("runs query pipes left to right", async () => {
    const res = await request(makeApp([UserController])).get(
      "/users/list?page=999&q=%20%20ada%20%20",
    );
    expect(res.body).toEqual({ page: 100, q: "ada", seed: "default" });
  });

  it("rejects a bad pipe value with 400 and a named message", async () => {
    const res = await request(makeApp([UserController])).get(
      "/users/list?page=abc",
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("page");
  });

  it("defaults POST to 201 and applies @Header", async () => {
    const res = await request(makeApp([UserController]))
      .post("/users")
      .send({ name: "ada" });
    expect(res.status).toBe(201);
    expect(res.headers["x-resource"]).toBe("user");
    expect(res.body).toEqual({ created: "ada", alsoName: "ada" });
  });

  it("sends an empty body for 204 even when the handler returns a value", async () => {
    const res = await request(makeApp([UserController])).delete("/users/u_1");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("respects a manually written response", async () => {
    const res = await request(makeApp([UserController])).get(
      "/users/raw/manual",
    );
    expect(res.status).toBe(418);
    expect(res.text).toBe("teapot");
  });

  it("injects @Req and @Headers", async () => {
    const res = await request(makeApp([UserController]))
      .get("/users/raw/echo")
      .set("X-Trace", "abc123");
    expect(res.body).toEqual({ path: "/users/raw/echo", trace: "abc123" });
  });

  it("forwards thrown HttpErrors with their status", async () => {
    const res = await request(makeApp([UserController])).get("/users/missing");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("User missing not found");
  });

  it("applies a global prefix", async () => {
    const app = makeApp([UserController], { prefix: "/api/v1" });
    expect((await request(app).get("/api/v1/users/u_1")).status).toBe(200);
    expect((await request(app).get("/users/u_1")).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Dependency injection via instances
 * ------------------------------------------------------------------ */

describe("dependency injection", () => {
  it("accepts a constructed instance", async () => {
    const res = await request(
      makeApp([new UserController("injected")]),
    ).get("/users/list");
    expect(res.body.seed).toBe("injected");
  });

  it("accepts a class and constructs it", async () => {
    const res = await request(makeApp([UserController])).get("/users/list");
    expect(res.body.seed).toBe("default");
  });
});

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

@Controller("/admin")
@UseGuards(authenticated)
class AdminController {
  @Get("/me")
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Delete("/:id")
  @UseGuards(roles("admin"))
  @HttpCode(204)
  remove(@Param("id") _id: string) {
    return undefined;
  }

  // @UseGuards below the route decorator — order must not matter.
  @Get("/below")
  @UseGuards(roles("admin"))
  below() {
    return { ok: true };
  }
}

describe("guards", () => {
  it("rejects with 403 when a class guard returns false", async () => {
    const res = await request(makeApp([AdminController])).get("/admin/me");
    expect(res.status).toBe(403);
  });

  it("passes when the class guard succeeds", async () => {
    const app = makeApp([AdminController], {
      user: { id: "u_1", role: "user" },
    });
    const res = await request(app).get("/admin/me");
    expect(res.body).toEqual({ id: "u_1", role: "user" });
  });

  it("uses the status thrown by a method guard", async () => {
    const app = makeApp([AdminController], {
      user: { id: "u_1", role: "user" },
    });
    const res = await request(app).delete("/admin/u_2");
    expect(res.status).toBe(403);
    expect(res.body.message).toContain("Requires one of: admin");
  });

  it("allows an admin through the method guard", async () => {
    const app = makeApp([AdminController], {
      user: { id: "u_1", role: "admin" },
    });
    expect((await request(app).delete("/admin/u_2")).status).toBe(204);
  });

  it("applies @UseGuards declared below the route decorator", async () => {
    const denied = makeApp([AdminController], {
      user: { id: "u_1", role: "user" },
    });
    const allowed = makeApp([AdminController], {
      user: { id: "u_1", role: "admin" },
    });
    expect((await request(denied).get("/admin/below")).status).toBe(403);
    expect((await request(allowed).get("/admin/below")).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Inheritance
 * ------------------------------------------------------------------ */

@Controller()
abstract class BaseController {
  @Get("/health")
  health() {
    return { ok: true };
  }

  @Get("/version")
  version() {
    return { version: "base" };
  }
}

@Controller("/things")
class ThingController extends BaseController {
  @Get("/version")
  override version() {
    return { version: "derived" };
  }

  @Get("/")
  list() {
    return [];
  }
}

describe("inheritance", () => {
  it("inherits base routes under the derived prefix", async () => {
    const res = await request(makeApp([ThingController])).get("/things/health");
    expect(res.body).toEqual({ ok: true });
  });

  it("lets the derived override win without duplicating the route", async () => {
    const res = await request(makeApp([ThingController])).get("/things/version");
    expect(res.body).toEqual({ version: "derived" });

    const versionRoutes = listRoutes([ThingController]).filter(
      (r) => r.path === "/things/version",
    );
    expect(versionRoutes).toHaveLength(1);
  });

  it("keeps the derived controller's own routes", async () => {
    expect((await request(makeApp([ThingController])).get("/things")).status).toBe(
      200,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Introspection
 * ------------------------------------------------------------------ */

describe("listRoutes", () => {
  it("reports mounted paths without instantiating the class", () => {
    let constructed = 0;

    @Controller("/side-effect")
    class SideEffectController {
      constructor() {
        constructed++;
      }
      @Get("/x")
      x() {
        return null;
      }
    }

    const routes = listRoutes([SideEffectController], { prefix: "/api" });
    expect(constructed).toBe(0);
    expect(routes).toEqual([
      {
        method: "get",
        path: "/api/side-effect/x",
        controller: "SideEffectController",
        handler: "x",
        sse: false,
      },
    ]);
  });

  it("matches what registerControllers actually mounts", () => {
    const app = express();
    const mounted = registerControllers(app, [UserController], {
      prefix: "/api",
    });
    const listed = listRoutes([UserController], { prefix: "/api" });
    expect(mounted.map((r) => r.path)).toEqual(listed.map((r) => r.path));
  });

  it("ignores undecorated classes", () => {
    class Plain {}
    expect(listRoutes([Plain])).toEqual([]);
  });
});
