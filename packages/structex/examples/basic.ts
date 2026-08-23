/**
 * Runnable example covering every feature.
 *
 *   npx tsx examples/basic.ts
 *
 *   curl localhost:3000/api/v1/users/list
 *   curl -X PUT localhost:3000/api/v1/users/u_9 -H 'content-type: application/json' -d '{"name":"Grace","email":"g@x.com"}' -i
 *   curl -X DELETE localhost:3000/api/v1/users/u_1 -H 'x-user-role: admin' -i
 *   curl -N localhost:3000/api/v1/users/events
 *   curl localhost:3000/api/v1/tenant/who -H 'x-tenant: acme'
 *   curl localhost:3000/openapi.json
 */
import express, {
  type ErrorRequestHandler,
  type Request,
} from "express";

import {
  ApiDoc,
  Body,
  Controller,
  Delete,
  Forbidden,
  Get,
  Header,
  HttpCode,
  Ip,
  NotFound,
  Param,
  Put,
  Query,
  Redirect,
  Sse,
  UseGuards,
  UseInterceptors,
  cache,
  clamp,
  createParamDecorator,
  isHttpError,
  printRoutes,
  registerControllers,
  required,
  respond,
  scoped,
  timing,
  toInt,
  toOpenApi,
  trim,
  type Guard,
  type SseEvent,
} from "../src/index.js";

/* ---------------- data layer (your DI dependency) ---------------- */

interface User {
  id: string;
  name: string;
  email: string;
}

class UserRepository {
  private readonly users = new Map<string, User>([
    ["u_1", { id: "u_1", name: "Ada", email: "ada@example.com" }],
  ]);

  list(page: number): User[] {
    return [...this.users.values()].slice((page - 1) * 10, page * 10);
  }
  find(id: string): User | undefined {
    return this.users.get(id);
  }
  upsert(id: string, input: Omit<User, "id">): { user: User; created: boolean } {
    const created = !this.users.has(id);
    const user = { id, ...input };
    this.users.set(id, user);
    return { user, created };
  }
  delete(id: string): boolean {
    return this.users.delete(id);
  }
}

/* ---------------- auth ---------------- */

interface AuthUser {
  id: string;
  role: "admin" | "user";
}

const fakeAuth = (req: Request, _res: unknown, next: () => void) => {
  (req as Request & { user?: AuthUser }).user = {
    id: "u_1",
    role: req.headers["x-user-role"] === "admin" ? "admin" : "user",
  };
  next();
};

const CurrentUser = () =>
  createParamDecorator((req) => (req as Request & { user?: AuthUser }).user);

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

/* ---------------- controllers ---------------- */

@Controller()
abstract class BaseController {
  @Get("/health")
  health() {
    return { ok: true, at: new Date().toISOString() };
  }
}

@Controller("/users")
@UseGuards(authenticated)
@UseInterceptors(timing())
@ApiDoc({ tags: ["Users"] })
class UserController extends BaseController {
  constructor(private readonly repo: UserRepository) {
    super();
  }

  @Get("/list")
  @UseInterceptors(cache({ ttl: 5_000 }))
  @ApiDoc({ summary: "List users, paginated" })
  list(@Query("page", toInt, clamp(1, 100)) page: number | undefined) {
    return { page: page ?? 1, items: this.repo.list(page ?? 1) };
  }

  @Sse("/events")
  async *events(): AsyncGenerator<SseEvent<{ seq: number; at: string }>> {
    for (let seq = 1; seq <= 5; seq++) {
      yield { event: "ping", id: String(seq), data: { seq, at: new Date().toISOString() } };
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  @Get("/:id")
  @ApiDoc({ summary: "Fetch one user" })
  findOne(@Param("id") id: string, @Ip() ip: string | undefined) {
    const user = this.repo.find(id);
    if (!user) throw NotFound(`User ${id} not found`);
    return { ...user, requestedFrom: ip };
  }

  /** 201 when created, 200 when updated — no @Res() needed. */
  @Put("/:id")
  @Header("X-Resource", "user")
  upsert(
    @Param("id") id: string,
    @Body("name", required, trim) name: string,
    @Body("email", required, trim) email: string,
    @CurrentUser() by: AuthUser,
  ) {
    const { user, created } = this.repo.upsert(id, { name, email });
    return respond({ ...user, savedBy: by.id }, { status: created ? 201 : 200 });
  }

  @Delete("/:id")
  @HttpCode(204)
  @UseGuards(roles("admin"))
  remove(@Param("id") id: string) {
    if (!this.repo.delete(id)) throw NotFound(`User ${id} not found`);
  }

  @Get("/:id/legacy")
  @Redirect()
  legacy(@Param("id") id: string) {
    return { url: `/api/v1/users/${id}`, status: 301 };
  }
}

/** Per-request instance: a different repository per tenant. */
@Controller("/tenant")
class TenantController {
  constructor(private readonly tenantId: string) {}

  @Get("/who")
  who() {
    return { tenantId: this.tenantId };
  }
}

/* ---------------- boot ---------------- */

const app = express();
app.use(express.json());
app.use(fakeAuth);

const controllers = [
  new UserController(new UserRepository()),
  scoped(
    TenantController,
    (req) => new TenantController(String(req.headers["x-tenant"] ?? "public")),
  ),
];

const routes = registerControllers(app, controllers, {
  prefix: "/api/v1",
  // App-wide envelope. Skipped for redirects, SSE, and 204s.
  transform: (result, ctx) => ({ data: result, path: ctx.path }),
});
printRoutes(routes);

const spec = toOpenApi([UserController, TenantController], {
  info: { title: "Example API", version: "1.0.0" },
  prefix: "/api/v1",
});
app.get("/openapi.json", (_req, res) => {
  res.json(spec);
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = isHttpError(err) ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    message: status === 500 ? "Internal server error" : err.message,
    ...(isHttpError(err) && err.details !== undefined
      ? { details: err.details }
      : {}),
  });
};
app.use(errorHandler);

app.listen(3000, () => console.log("\nlistening on http://localhost:3000"));
