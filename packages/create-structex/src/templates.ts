import { toCamel, toKebab, toPascal } from "./util.js";

export type TemplateName = "minimal" | "modules";

export interface ScaffoldOptions {
  name: string;
  template: TemplateName;
  structexVersion: string;
}

/* ------------------------------------------------------------------ *
 * Shared project files
 * ------------------------------------------------------------------ */

function packageJson({ name, structexVersion }: ScaffoldOptions): string {
  return `${JSON.stringify(
    {
      name: toKebab(name),
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "tsx watch src/main.ts",
        start: "node --experimental-strip-types src/main.ts",
        build: "tsc",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        express: "^5.1.0",
        structex: structexVersion,
      },
      devDependencies: {
        "@types/express": "^5.0.0",
        "@types/node": "^22.10.0",
        "@types/supertest": "^6.0.2",
        supertest: "^7.1.4",
        tsx: "^4.19.2",
        typescript: "^5.9.2",
        vitest: "^2.1.9",
      },
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",

    // Required by Structex: parameter decorators (@Body, @Param, @Inject)
    // do not exist in TypeScript's standard decorators.
    "experimentalDecorators": true,

    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
`;

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // esbuild needs to be told about legacy decorators explicitly.
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        target: "ES2022",
        useDefineForClassFields: false,
      },
    },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
`;

const GITIGNORE = `node_modules
dist
coverage
.env
.DS_Store
`;

const ENV_EXAMPLE = `PORT=3000
DATABASE_URL=postgres://localhost:5432/app
`;

const ERROR_HANDLER = `import { createErrorHandler } from "structex";

/**
 * Central error handler. Every handler, guard, and pipe that throws lands
 * here — Structex forwards rejections to next(err) for you.
 *
 * HttpErrors keep their status; anything else becomes a generic 500 so
 * internal messages never reach a client.
 */
export const errorHandler = createErrorHandler({
  exposeStack: process.env.NODE_ENV !== "production",
});
`;

/* ------------------------------------------------------------------ *
 * Minimal template
 * ------------------------------------------------------------------ */

const MINIMAL_MAIN = `import express from "express";
import { printRoutes, registerControllers } from "structex";

import { errorHandler } from "./error-handler.js";
import { HealthController } from "./health.controller.js";
import { UsersController } from "./users.controller.js";

const app = express();

// Still plain Express — every middleware you already know keeps working.
app.use(express.json());

const routes = registerControllers(
  app,
  [new HealthController(), new UsersController()],
  { prefix: "/api" },
);

printRoutes(routes);

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`\\nlistening on http://localhost:\${port}\`));
`;

const MINIMAL_HEALTH = `import { Controller, Get } from "structex";

@Controller("/health")
export class HealthController {
  @Get("/")
  check() {
    return { ok: true, uptime: process.uptime() };
  }
}
`;

const MINIMAL_USERS = `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFound,
  Param,
  Post,
  Query,
} from "structex";
import { clamp, required, toInt, trim } from "structex/pipes";

export interface User {
  id: string;
  name: string;
  email: string;
}

@Controller("/users")
export class UsersController {
  private readonly users = new Map<string, User>([
    ["u_1", { id: "u_1", name: "Ada", email: "ada@example.com" }],
  ]);
  private nextId = 2;

  // Static routes must come before "/:id", or Express matches :id = "count".
  @Get("/count")
  count() {
    return { total: this.users.size };
  }

  @Get("/")
  list(@Query("page", toInt, clamp(1, 100)) page: number | undefined) {
    const current = page ?? 1;
    return {
      page: current,
      items: [...this.users.values()].slice((current - 1) * 10, current * 10),
    };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    const user = this.users.get(id);
    if (!user) throw NotFound(\`User \${id} not found\`);
    return user;
  }

  @Post("/")
  create(
    @Body("name", required, trim) name: string,
    @Body("email", required, trim) email: string,
  ) {
    const user: User = { id: \`u_\${this.nextId++}\`, name, email };
    this.users.set(user.id, user);
    return user; // POST defaults to 201
  }

  @Delete("/:id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    if (!this.users.delete(id)) throw NotFound(\`User \${id} not found\`);
  }
}
`;

const MINIMAL_TEST = `import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTestApp } from "structex/testing";

import { UsersController } from "../src/users.controller.js";

function build() {
  return createTestApp([new UsersController()], { express }).app;
}

describe("UsersController", () => {
  it("returns a seeded user", async () => {
    const res = await request(build()).get("/users/u_1");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Ada");
  });

  it("404s an unknown user", async () => {
    const res = await request(build()).get("/users/nope");
    expect(res.status).toBe(404);
  });

  it("creates a user with 201", async () => {
    const res = await request(build())
      .post("/users")
      .send({ name: "Grace", email: "grace@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("rejects a missing field with 400", async () => {
    const res = await request(build()).post("/users").send({ name: "X" });
    expect(res.status).toBe(400);
  });
});
`;

/* ------------------------------------------------------------------ *
 * Modules template
 * ------------------------------------------------------------------ */

const MODULES_MAIN = `import express from "express";
import { printRoutes } from "structex";
import { createApplication } from "structex/di";

import { AppModule } from "./app.module.js";
import { errorHandler } from "./error-handler.js";

const app = express();
app.use(express.json());

// Async: factory providers may open connections, and onModuleInit runs
// before the first request is served.
const application = await createApplication(app, AppModule, { prefix: "/api" });

printRoutes(application.routes);

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () =>
  console.log(\`\\nlistening on http://localhost:\${port}\`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void application.close().then(() => process.exit(0));
    });
  });
}
`;

const MODULES_APP_MODULE = `import { defineModule } from "structex/di";

import { ConfigModule } from "./config/config.module.js";
import { HealthModule } from "./health/health.module.js";
import { UsersModule } from "./users/users.module.js";

export const AppModule = defineModule({
  name: "AppModule",
  imports: [ConfigModule, HealthModule, UsersModule],
});
`;

const MODULES_CONFIG = `import { defineModule, token } from "structex/di";

export interface AppConfig {
  databaseUrl: string;
  port: number;
}

export const CONFIG = token<AppConfig>("CONFIG");

export const ConfigModule = defineModule({
  name: "ConfigModule",
  providers: [
    {
      provide: CONFIG,
      useValue: {
        databaseUrl:
          process.env.DATABASE_URL ?? "postgres://localhost:5432/app",
        port: Number(process.env.PORT ?? 3000),
      },
    },
  ],
  // Only exported providers are visible to importing modules.
  exports: [CONFIG],
});
`;

const MODULES_HEALTH = `import { Controller, Get } from "structex";
import { defineModule } from "structex/di";

@Controller("/health")
export class HealthController {
  @Get("/")
  check() {
    return { ok: true, uptime: process.uptime() };
  }
}

export const HealthModule = defineModule({
  name: "HealthModule",
  controllers: [HealthController],
});
`;

const MODULES_USERS_SERVICE = `import { NotFound } from "structex";
import { Inject } from "structex/di";

import { CONFIG, type AppConfig } from "../config/config.module.js";

export interface User {
  id: string;
  name: string;
  email: string;
}

export class UsersService {
  private readonly users = new Map<string, User>([
    ["u_1", { id: "u_1", name: "Ada", email: "ada@example.com" }],
  ]);
  private nextId = 2;

  // Every injected parameter needs @Inject — there is no type reflection.
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  list(): User[] {
    return [...this.users.values()];
  }

  find(id: string): User {
    const user = this.users.get(id);
    if (!user) throw NotFound(\`User \${id} not found\`);
    return user;
  }

  create(input: Omit<User, "id">): User {
    const user: User = { id: \`u_\${this.nextId++}\`, ...input };
    this.users.set(user.id, user);
    return user;
  }

  remove(id: string): void {
    if (!this.users.delete(id)) throw NotFound(\`User \${id} not found\`);
  }

  describeSource(): string {
    return this.config.databaseUrl;
  }
}
`;

const MODULES_USERS_CONTROLLER = `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "structex";
import { Inject } from "structex/di";
import { required, trim } from "structex/pipes";

import { UsersService } from "./users.service.js";

@Controller("/users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get("/")
  list() {
    return { items: this.users.list() };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    return this.users.find(id);
  }

  @Post("/")
  create(
    @Body("name", required, trim) name: string,
    @Body("email", required, trim) email: string,
  ) {
    return this.users.create({ name, email });
  }

  @Delete("/:id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    this.users.remove(id);
  }
}
`;

const MODULES_USERS_MODULE = `import { defineModule } from "structex/di";

import { ConfigModule } from "../config/config.module.js";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

export const UsersModule = defineModule({
  name: "UsersModule",
  imports: [ConfigModule],
  providers: [UsersService],
  controllers: [UsersController],
  // Export UsersService to let other modules inject it.
  exports: [UsersService],
});
`;

const MODULES_TEST = `import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTestApp } from "structex/testing";

import { UsersController } from "../src/users/users.controller.js";
import { UsersService } from "../src/users/users.service.js";

// Controllers take their dependencies in the constructor, so a unit test can
// hand them a fake without booting the DI container.
function build() {
  const service = new UsersService({
    databaseUrl: "memory://test",
    port: 0,
  });
  return createTestApp([new UsersController(service)], { express }).app;
}

describe("UsersController", () => {
  it("returns a seeded user", async () => {
    const res = await request(build()).get("/users/u_1");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Ada");
  });

  it("404s an unknown user", async () => {
    expect((await request(build()).get("/users/nope")).status).toBe(404);
  });

  it("creates a user with 201", async () => {
    const res = await request(build())
      .post("/users")
      .send({ name: "Grace", email: "grace@example.com" });
    expect(res.status).toBe(201);
  });
});
`;

function readme(options: ScaffoldOptions): string {
  const name = toKebab(options.name);
  const isModules = options.template === "modules";

  return `# ${name}

Built with [Structex](https://github.com/bharath2408/structex) — structure for Express, without leaving Express behind.

## Scripts

\`\`\`bash
npm run dev        # watch mode
npm test           # run tests
npm run typecheck  # type check
npm run build      # compile to dist/
\`\`\`

## Try it

\`\`\`bash
curl localhost:3000/api/users
curl localhost:3000/api/users/u_1
curl -X POST localhost:3000/api/users \\
  -H 'content-type: application/json' \\
  -d '{"name":"Grace","email":"grace@example.com"}'
\`\`\`

## Layout

${
  isModules
    ? `\`\`\`
src/
  main.ts                    boot: createApplication + error handler
  app.module.ts              root module
  error-handler.ts
  config/config.module.ts    CONFIG token, exported
  users/
    users.module.ts          wires controller + service
    users.controller.ts      routes
    users.service.ts         business logic
\`\`\`

Providers are private to their module unless listed in \`exports\`.`
    : `\`\`\`
src/
  main.ts               boot: registerControllers + error handler
  error-handler.ts
  health.controller.ts
  users.controller.ts
\`\`\`

No DI container here — controllers are constructed directly. Move to the
\`modules\` template when manual wiring starts to hurt.`
}

## Generate more

\`\`\`bash
npx structex g controller orders
npx structex g service orders
${isModules ? "npx structex g resource orders   # module + controller + service\n" : ""}\`\`\`

## Notes

- \`experimentalDecorators\` is required and already set in \`tsconfig.json\`.
- Declare static routes before \`/:id\`, or Express will match the wildcard first.
- It is still Express: \`app.use()\`, middleware, and \`@Res()\` all work normally.
`;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export function buildProjectFiles(
  options: ScaffoldOptions,
): Record<string, string> {
  const common: Record<string, string> = {
    "package.json": packageJson(options),
    "tsconfig.json": TSCONFIG,
    "vitest.config.ts": VITEST_CONFIG,
    ".gitignore": GITIGNORE,
    ".env.example": ENV_EXAMPLE,
    "README.md": readme(options),
    "src/error-handler.ts": ERROR_HANDLER,
  };

  if (options.template === "minimal") {
    return {
      ...common,
      "src/main.ts": MINIMAL_MAIN,
      "src/health.controller.ts": MINIMAL_HEALTH,
      "src/users.controller.ts": MINIMAL_USERS,
      "test/users.test.ts": MINIMAL_TEST,
    };
  }

  return {
    ...common,
    "src/main.ts": MODULES_MAIN,
    "src/app.module.ts": MODULES_APP_MODULE,
    "src/config/config.module.ts": MODULES_CONFIG,
    "src/health/health.module.ts": MODULES_HEALTH,
    "src/users/users.module.ts": MODULES_USERS_MODULE,
    "src/users/users.controller.ts": MODULES_USERS_CONTROLLER,
    "src/users/users.service.ts": MODULES_USERS_SERVICE,
    "test/users.test.ts": MODULES_TEST,
  };
}

/* ------------------------------------------------------------------ *
 * Generators
 * ------------------------------------------------------------------ */

export type GeneratorKind =
  | "controller"
  | "service"
  | "module"
  | "guard"
  | "interceptor"
  | "pipe"
  | "resource";

export const GENERATOR_KINDS: GeneratorKind[] = [
  "controller",
  "service",
  "module",
  "guard",
  "interceptor",
  "pipe",
  "resource",
];

function controllerFile(name: string, withService: boolean): string {
  const Pascal = toPascal(name);
  const kebab = toKebab(name);
  const camel = toCamel(name);

  if (!withService) {
    return `import { Controller, Get, HttpCode, Param, Post, Body } from "structex";

@Controller("/${kebab}")
export class ${Pascal}Controller {
  @Get("/")
  list() {
    return { items: [] };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    return { id };
  }

  @Post("/")
  create(@Body() body: unknown) {
    return body;
  }

  @HttpCode(204)
  remove(@Param("id") _id: string) {}
}
`;
  }

  return `import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "structex";
import { Inject } from "structex/di";

import { ${Pascal}Service } from "./${kebab}.service.js";

@Controller("/${kebab}")
export class ${Pascal}Controller {
  constructor(@Inject(${Pascal}Service) private readonly ${camel}: ${Pascal}Service) {}

  @Get("/")
  list() {
    return { items: this.${camel}.list() };
  }

  @Get("/:id")
  findOne(@Param("id") id: string) {
    return this.${camel}.find(id);
  }

  @Post("/")
  create(@Body() input: Record<string, unknown>) {
    return this.${camel}.create(input);
  }

  @Delete("/:id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    this.${camel}.remove(id);
  }
}
`;
}

function serviceFile(name: string): string {
  const Pascal = toPascal(name);

  return `import { NotFound } from "structex";

export interface ${Pascal}Record {
  id: string;
  [key: string]: unknown;
}

export class ${Pascal}Service {
  private readonly items = new Map<string, ${Pascal}Record>();
  private nextId = 1;

  list(): ${Pascal}Record[] {
    return [...this.items.values()];
  }

  find(id: string): ${Pascal}Record {
    const item = this.items.get(id);
    if (!item) throw NotFound(\`${Pascal} \${id} not found\`);
    return item;
  }

  create(input: Record<string, unknown>): ${Pascal}Record {
    const item: ${Pascal}Record = { id: String(this.nextId++), ...input };
    this.items.set(item.id, item);
    return item;
  }

  remove(id: string): void {
    if (!this.items.delete(id)) throw NotFound(\`${Pascal} \${id} not found\`);
  }
}
`;
}

function moduleFile(name: string, full: boolean): string {
  const Pascal = toPascal(name);
  const kebab = toKebab(name);

  if (!full) {
    return `import { defineModule } from "structex/di";

export const ${Pascal}Module = defineModule({
  name: "${Pascal}Module",
  imports: [],
  providers: [],
  controllers: [],
  exports: [],
});
`;
  }

  return `import { defineModule } from "structex/di";

import { ${Pascal}Controller } from "./${kebab}.controller.js";
import { ${Pascal}Service } from "./${kebab}.service.js";

export const ${Pascal}Module = defineModule({
  name: "${Pascal}Module",
  providers: [${Pascal}Service],
  controllers: [${Pascal}Controller],
  exports: [${Pascal}Service],
});
`;
}

function guardFile(name: string): string {
  const camel = toCamel(name);

  return `import { Forbidden, Unauthorized } from "structex";
import type { Guard } from "structex";

/**
 * Return false for a plain 403, or throw for a specific status and message.
 * Guards run after middleware, so anything middleware set on \`req\` is here.
 */
export const ${camel}Guard: Guard = (req) => {
  const user = (req as typeof req & { user?: { role?: string } }).user;

  if (!user) throw Unauthorized();
  if (user.role !== "admin") throw Forbidden("Requires the admin role");

  return true;
};
`;
}

function interceptorFile(name: string): string {
  const camel = toCamel(name);

  return `import type { Interceptor } from "structex/interceptors";

/**
 * Wraps parameter resolution and the handler call.
 *
 * next() may be called more than once (that is how retry works), so keep
 * anything downstream idempotent.
 */
export const ${camel}Interceptor: Interceptor = async (ctx, next) => {
  const started = performance.now();

  const result = await next();

  ctx.res.set(
    "X-Handler-Duration",
    \`\${(performance.now() - started).toFixed(1)}ms\`,
  );

  return result;
};
`;
}

function pipeFile(name: string): string {
  const camel = toCamel(name);

  return `import { BadRequest } from "structex";
import type { Pipe } from "structex/pipes";

/**
 * Transforms and validates one decorated argument. Throw to reject the
 * request — the error reaches your error handler with its status intact.
 */
export const ${camel}Pipe: Pipe<unknown, string> = (value, meta) => {
  if (typeof value !== "string" || value.length === 0) {
    throw BadRequest(\`\${meta.key ?? meta.type} must be a non-empty string\`);
  }
  return value;
};
`;
}

export function buildGeneratorFiles(
  kind: GeneratorKind,
  name: string,
): Record<string, string> {
  const kebab = toKebab(name);

  switch (kind) {
    case "controller":
      return { [`${kebab}.controller.ts`]: controllerFile(name, false) };
    case "service":
      return { [`${kebab}.service.ts`]: serviceFile(name) };
    case "module":
      return { [`${kebab}.module.ts`]: moduleFile(name, false) };
    case "guard":
      return { [`${kebab}.guard.ts`]: guardFile(name) };
    case "interceptor":
      return { [`${kebab}.interceptor.ts`]: interceptorFile(name) };
    case "pipe":
      return { [`${kebab}.pipe.ts`]: pipeFile(name) };
    case "resource":
      return {
        [`${kebab}.module.ts`]: moduleFile(name, true),
        [`${kebab}.controller.ts`]: controllerFile(name, true),
        [`${kebab}.service.ts`]: serviceFile(name),
      };
  }
}
