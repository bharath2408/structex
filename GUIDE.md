# The Structex Guide

An end-to-end walkthrough: install the tools, scaffold a project, and build a
real feature — validation, dependency injection, a guard, an interceptor, and
tests — from nothing to a working API. Every code block on this page was
actually run before being written down; none of it is hypothetical.

For a feature-by-feature reference (every decorator, pipe, and option), see
[`packages/structex/README.md`](packages/structex/README.md). This guide is
the narrative path through the same material.

---

## 0. Before you start

- **Node 20 or later.** Structex's tooling (Vitest 4, tsup) requires it —
  check with `node -v`.
- **A GitHub account with access to this registry.** Both packages are
  published on **GitHub Packages**, not npmjs.org, which means installing
  them requires a GitHub token even though the packages themselves are
  public. Add this to your `~/.npmrc`:

  ```
  @bharath2408:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=<a token with read:packages>
  ```

  Generate the token at <https://github.com/settings/tokens> (classic token,
  `read:packages` scope is enough to install). Without this, `npx
  @bharath2408/create-structex` fails with a 404 because npm falls back to
  the public registry, which has never heard of this scope.

---

## 1. Scaffold a project

```bash
npx @bharath2408/create-structex tasks-api --template modules
cd tasks-api
```

`--template modules` gives you a DI container and module boundaries from the
start. The other option, `--template minimal`, wires controllers directly
with no container — a reasonable choice if you just want tidier routes on
top of Express, with room to grow into `modules` later without rewriting
controllers.

If `npm install` fails partway through (flaky network, registry hiccup), the
CLI tells you and you just re-run `npm install` yourself — nothing is left
half-written.

## 2. Tour what got created

```
tasks-api/
  src/
    main.ts                 boot: createApplication + error handler
    app.module.ts            root module — lists every feature module
    error-handler.ts
    config/config.module.ts  a CONFIG token, exported for other modules
    health/health.module.ts
    users/
      users.module.ts        wires controller + service together
      users.controller.ts    routes
      users.service.ts       business logic, no Express in sight
  test/users.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
```

Two things worth noticing immediately:

- **Services never see `req`/`res`.** `UsersService` is plain TypeScript —
  you could unit test it without an HTTP layer at all. Only controllers deal
  with Express types.
- **Modules are the unit of encapsulation.** A service is invisible outside
  its module unless the module lists it under `exports`. `ConfigModule`
  exports its `CONFIG` token specifically so other modules can inject it;
  everything else about it stays private.

## 3. Read the boot file

```ts
// src/main.ts
import express from "express";
import { printRoutes } from "@bharath2408/structex";
import { createApplication } from "@bharath2408/structex/di";

import { AppModule } from "./app.module.js";
import { errorHandler } from "./error-handler.js";

const app = express();
app.use(express.json());

const application = await createApplication(app, AppModule, { prefix: "/api" });

printRoutes(application.routes);

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () =>
  console.log(`\nlistening on http://localhost:${port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void application.close().then(() => process.exit(0));
    });
  });
}
```

`createApplication` walks `AppModule`'s import tree, builds the DI container,
and mounts every controller it finds under `/api`. `printRoutes` then logs a
color-coded table of everything that got registered — genuinely useful as a
boot-time sanity check, not just decoration:

```
GET     /api/health  →  HealthController.check
GET     /api/users   →  UsersController.list
...
```

The graceful-shutdown loop at the bottom matters once you have real
resources (database pools, message consumers) wired up as providers —
`application.close()` runs each module's cleanup hook before the process
exits.

## 4. Build a feature: Tasks

We'll add a `/tasks` resource with validation, an authorization guard, and
request timing — the pieces you'll reach for in almost every real feature.

### 4.1 Generate the skeleton

```bash
npx structex g resource tasks
```

```
✔ Generated resource Tasks
  + src/tasks/tasks.module.ts
  + src/tasks/tasks.controller.ts
  + src/tasks/tasks.service.ts

Next
  Register it in your root module:

  // src/app.module.ts
  import { TasksModule } from "./tasks/tasks.module.js";

  export const AppModule = defineModule({
    imports: [TasksModule],
  });
```

Do exactly what it says — add `TasksModule` to `AppModule`'s `imports`. The
generator deliberately does *not* edit `app.module.ts` for you: rewriting a
user's source by string manipulation is fragile, and a wrong edit is worse
than a reminder.

```ts
// src/app.module.ts
import { defineModule } from "@bharath2408/structex/di";

import { ConfigModule } from "./config/config.module.js";
import { HealthModule } from "./health/health.module.js";
import { UsersModule } from "./users/users.module.js";
import { TasksModule } from "./tasks/tasks.module.js";

export const AppModule = defineModule({
  name: "AppModule",
  imports: [ConfigModule, HealthModule, UsersModule, TasksModule],
});
```

### 4.2 The service: state and rules, no HTTP

Replace the generated `tasks.service.ts` with a real model:

```ts
// src/tasks/tasks.service.ts
import { NotFound } from "@bharath2408/structex";

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  priority: Priority;
  done: boolean;
}

export interface CreateTaskInput {
  title: string;
  priority: Priority;
}

export class TasksService {
  private readonly tasks = new Map<string, Task>([
    ["t_1", { id: "t_1", title: "Write the guide", priority: "high", done: false }],
  ]);
  private nextId = 2;

  list(): Task[] {
    return [...this.tasks.values()];
  }

  find(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw NotFound(`Task ${id} not found`);
    return task;
  }

  create(input: CreateTaskInput): Task {
    const task: Task = { id: `t_${this.nextId++}`, done: false, ...input };
    this.tasks.set(task.id, task);
    return task;
  }

  complete(id: string): Task {
    const task = this.find(id);
    task.done = true;
    return task;
  }

  remove(id: string): void {
    if (!this.tasks.delete(id)) throw NotFound(`Task ${id} not found`);
  }
}
```

`NotFound(...)` is one of Structex's `HttpError` factories — throw it from
anywhere (service, controller, guard, pipe) and the central error handler
turns it into the right status code and JSON body automatically.

### 4.3 Validate input with pipes

Built-in pipes (`required`, `trim`, `toInt`, `clamp`, …) cover common cases.
For the `priority` field, which needs to be one of three specific strings,
write a small custom pipe:

```ts
// src/tasks/priority.pipe.ts
import { BadRequest } from "@bharath2408/structex";
import type { Pipe } from "@bharath2408/structex/pipes";

const VALID = new Set(["low", "medium", "high"]);

export const priorityPipe: Pipe<unknown, "low" | "medium" | "high"> = (value, meta) => {
  if (typeof value !== "string" || !VALID.has(value)) {
    throw BadRequest(`${meta.key ?? meta.type} must be one of: low, medium, high`);
  }
  return value as "low" | "medium" | "high";
};
```

A pipe is just a function: `(value, meta) => transformedValue`, called before
your handler ever sees the argument. Throw to reject the request; return to
accept it, possibly transformed.

### 4.4 Protect a route with a guard

```ts
// src/tasks/admin.guard.ts
import { Forbidden } from "@bharath2408/structex";
import type { Guard } from "@bharath2408/structex";

/**
 * Real apps read this from session/JWT middleware. A header stands in here
 * so the example stays self-contained.
 */
export const adminGuard: Guard = (req) => {
  if (req.header("x-role") !== "admin") {
    throw Forbidden("Requires the admin role");
  }
  return true;
};
```

A guard runs before the handler and gets the raw Express `req`/`res` — return
`false` for a plain 403, or throw an `HttpError` for a specific status and
message.

### 4.5 The controller: wiring it all together

```ts
// src/tasks/tasks.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from "@bharath2408/structex";
import { Inject } from "@bharath2408/structex/di";
import { required, trim } from "@bharath2408/structex/pipes";
import { timing } from "@bharath2408/structex/interceptors";

import { adminGuard } from "./admin.guard.js";
import { priorityPipe } from "./priority.pipe.js";
import { TasksService, type Priority } from "./tasks.service.js";

@Controller("/tasks")
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get("/")
  @UseInterceptors(timing())
  list() {
    return { items: this.tasks.list() };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    return this.tasks.find(id);
  }

  @Post("/")
  create(
    @Body("title", required, trim) title: string,
    @Body("priority", priorityPipe) priority: Priority,
  ) {
    return this.tasks.create({ title, priority }); // POST defaults to 201
  }

  @Post("/:id/complete")
  complete(@Param("id") id: string) {
    return this.tasks.complete(id);
  }

  @Delete("/:id")
  @HttpCode(204)
  @UseGuards(adminGuard)
  remove(@Param("id") id: string) {
    this.tasks.remove(id);
  }
}
```

Three things to notice:

- **`@Body("title", required, trim)`** runs both pipes left to right, then
  hands you a guaranteed-non-empty, trimmed string — no `if (!title)` check
  needed in the handler body.
- **`@UseInterceptors(timing())`** wraps `list()` and logs
  `GET /tasks 0.4ms` on every call. `timing` is a built-in interceptor
  factory; writing your own is the same shape:
  `async (ctx, next) => { ...; return await next(); }`.
- **`@UseGuards(adminGuard)`** on `remove()` means every `DELETE /tasks/:id`
  is checked before `remove()` ever runs.

### 4.6 Run it

```bash
npm run dev
```

```
GET     /api/tasks               →  TasksController.list
GET     /api/tasks/:id           →  TasksController.findOne
POST    /api/tasks               →  TasksController.create
POST    /api/tasks/:id/complete  →  TasksController.complete
DELETE  /api/tasks/:id           →  TasksController.remove

listening on http://localhost:3000
```

Try it end to end:

```bash
# seeded task
curl http://localhost:3000/api/tasks

# rejected: priority isn't one of the allowed values
curl -X POST http://localhost:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Ship it","priority":"urgent"}'
# → 400 {"message":"priority must be one of: low, medium, high"}

# accepted
curl -X POST http://localhost:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Ship it","priority":"high"}'
# → 201 {"id":"t_2","done":false,"title":"Ship it","priority":"high"}

# blocked: no admin role
curl -i -X DELETE http://localhost:3000/api/tasks/t_1
# → 403

# allowed
curl -i -X DELETE http://localhost:3000/api/tasks/t_1 -H 'x-role: admin'
# → 204
```

Every response above is exactly what running this code produces.

## 5. Test the feature

`createTestApp` builds a real Express app around your controllers without
booting the DI container or opening a port — pass fakes straight into the
constructor.

```ts
// test/tasks.test.ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTestApp } from "@bharath2408/structex/testing";

import { TasksController } from "../src/tasks/tasks.controller.js";
import { TasksService } from "../src/tasks/tasks.service.js";

function build() {
  return createTestApp([new TasksController(new TasksService())], { express }).app;
}

describe("TasksController", () => {
  it("returns the seeded task", async () => {
    const res = await request(build()).get("/tasks/t_1");
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Write the guide");
  });

  it("rejects an invalid priority with 400", async () => {
    const res = await request(build())
      .post("/tasks")
      .send({ title: "Ship it", priority: "urgent" });
    expect(res.status).toBe(400);
  });

  it("creates a task with 201", async () => {
    const res = await request(build())
      .post("/tasks")
      .send({ title: "Ship it", priority: "medium" });
    expect(res.status).toBe(201);
    expect(res.body.done).toBe(false);
  });

  it("blocks delete without the admin role", async () => {
    const res = await request(build()).delete("/tasks/t_1");
    expect(res.status).toBe(403);
  });

  it("allows delete with the admin role", async () => {
    const res = await request(build()).delete("/tasks/t_1").set("x-role", "admin");
    expect(res.status).toBe(204);
  });
});
```

```bash
npm test
```

```
 ✓ test/users.test.ts (3 tests)
 ✓ test/tasks.test.ts (5 tests)

 Test Files  2 passed (2)
      Tests  8 passed (8)
```

No mocking framework, no HTTP server, no port conflicts between test files —
each `build()` call is an isolated Express app in memory.

## 6. How errors actually work

Every controller, guard, pipe, and interceptor in the request path can throw.
Structex catches the rejection and forwards it to `next(err)` for you — you
never need a `try/catch` in a handler just to keep the process alive.

```ts
// src/error-handler.ts (generated for you)
import { createErrorHandler } from "@bharath2408/structex";

export const errorHandler = createErrorHandler({
  exposeStack: process.env.NODE_ENV !== "production",
});
```

- Throwing one of the built-in factories (`NotFound`, `BadRequest`,
  `Forbidden`, `Unauthorized`, `Conflict`, …) keeps that exact status and
  message.
- Throwing anything else (a plain `Error`, a bug) becomes a generic 500 —
  internal messages never leak to a client in production, but
  `exposeStack: true` in development shows you what broke.

## 7. Bonus: generate an OpenAPI spec

Routes, methods, and path parameters are derived automatically from your
decorators — `/tasks/:id` becomes `/tasks/{id}` with no extra work. Add
`@ApiDoc` where you want richer descriptions:

```ts
import { ApiDoc, Controller, Get, Param } from "@bharath2408/structex";
import { toOpenApi } from "@bharath2408/structex/openapi";

@Controller("/tasks")
@ApiDoc({ tags: ["Tasks"] })
class TasksController {
  @Get("/:id")
  @ApiDoc({ summary: "Fetch a task", responses: { "200": { description: "ok" } } })
  findOne(@Param("id") id: string) {}
}

const spec = toOpenApi([TasksController], {
  info: { title: "Tasks API", version: "1.0.0" },
  prefix: "/api",
});
app.get("/openapi.json", (_req, res) => res.json(spec));
```

**Response and request-body schemas are not inferred** — that would need
`reflect-metadata`, the exact dependency this framework avoids. Supply
`requestBody`/`responses` yourself, e.g. generated from `zod-to-json-schema`
if you already validate with Zod.

## 8. Build and run for production

```bash
npm run build   # tsc → dist/
node dist/main.js
```

`main.ts`'s `SIGINT`/`SIGTERM` handlers already close the DI container
(running any module's cleanup hooks) before the process exits — no extra
work needed for a clean shutdown under a process manager or container
orchestrator.

## 9. CLI reference recap

```bash
npx @bharath2408/create-structex <dir> --template modules|minimal
npx structex g resource <name>       # module + controller + service
npx structex g controller <name>
npx structex g service <name>
npx structex g module <name>
npx structex g guard <name>
npx structex g interceptor <name>
npx structex g pipe <name>
```

Generators never overwrite an existing file without `--force` — clobbering
your code is the one mistake a generator can't take back.

## 10. Troubleshooting

**`npx @bharath2408/create-structex` 404s.** You're missing the `.npmrc`
lines from [step 0](#0-before-you-start) — npm silently falls back to
npmjs.org for a scope it doesn't recognize, and this package has never been
published there.

**`experimentalDecorators` errors in your editor or build.** The setting has
to reach whatever performs the TypeScript transform — `tsconfig.json` alone
isn't enough for esbuild/tsup/SWC/Vitest, which each need it passed
explicitly. The scaffolded `tsconfig.json` and `vitest.config.ts` already do
this; if you hand-roll a build step, mirror that config.

**A generated project's `npm install` fails on Windows with `ENOENT`.**
Fixed in `create-structex@0.5.1`+ — update if you're on an older version.

**5 npm audit vulnerabilities in a freshly scaffolded project.** Fixed in
`create-structex@0.5.3`+ (bumped the template's pinned `vitest` off an old
2.x line). Delete `node_modules` + the lockfile and reinstall if your project
predates this.

---

Full API reference: [`packages/structex/README.md`](packages/structex/README.md) ·
CLI reference: [`packages/create-structex/README.md`](packages/create-structex/README.md)
