/**
 * Module system + DI container.
 *
 *   npx tsx examples/modules.ts
 *
 *   curl localhost:3001/api/users/u_1
 *   curl localhost:3001/api/orders/mine -H 'x-tenant: acme'
 *   curl localhost:3001/api/orders/mine -H 'x-tenant: globex'
 */
import express, {
  type ErrorRequestHandler,
  type Request,
} from "express";

import {
  Controller,
  Get,
  Inject,
  NotFound,
  Param,
  REQUEST,
  createApplication,
  defineModule,
  isHttpError,
  printRoutes,
  token,
  type OnDispose,
  type OnModuleInit,
} from "../src/index.js";

/* ================================================================== *
 * ConfigModule — a value provider, exported
 * ================================================================== */

interface Config {
  databaseUrl: string;
}

const CONFIG = token<Config>("CONFIG");

const ConfigModule = defineModule({
  name: "ConfigModule",
  providers: [
    {
      provide: CONFIG,
      useValue: {
        databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/demo",
      },
    },
  ],
  exports: [CONFIG],
});

/* ================================================================== *
 * DatabaseModule — async factory + lifecycle hooks
 * ================================================================== */

class Database implements OnModuleInit, OnDispose {
  private connected = false;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  async onModuleInit() {
    await new Promise((r) => setTimeout(r, 50)); // pretend to connect
    this.connected = true;
    console.log(`[db] connected to ${this.config.databaseUrl}`);
  }

  async onDispose() {
    this.connected = false;
    console.log("[db] connection closed");
  }

  find(table: string, id: string): Record<string, unknown> | undefined {
    if (!this.connected) throw new Error("Database not ready");
    return id.startsWith("u_") ? { id, table } : undefined;
  }

  forTenant(tenantId: string): TenantDatabase {
    return new TenantDatabase(this, tenantId);
  }
}

class TenantDatabase {
  constructor(
    private readonly db: Database,
    readonly tenantId: string,
  ) {}

  orders(): { id: string; tenant: string }[] {
    return [{ id: "o_1", tenant: this.tenantId }];
  }
}

const DatabaseModule = defineModule({
  name: "DatabaseModule",
  imports: [ConfigModule],
  providers: [Database],
  exports: [Database],
});

/* ================================================================== *
 * UserModule — a private service, a public controller
 * ================================================================== */

class UserService {
  constructor(@Inject(Database) private readonly db: Database) {}

  find(id: string) {
    const row = this.db.find("users", id);
    if (!row) throw NotFound(`User ${id} not found`);
    return row;
  }
}

@Controller("/users")
class UserController {
  constructor(@Inject(UserService) private readonly users: UserService) {}

  @Get("/:id")
  findOne(@Param("id") id: string) {
    return this.users.find(id);
  }
}

const UserModule = defineModule({
  name: "UserModule",
  imports: [DatabaseModule],
  providers: [UserService], // NOT exported — private to this module
  controllers: [UserController],
});

/* ================================================================== *
 * OrderModule — request-scoped tenant database
 * ================================================================== */

const TENANT_DB = token<TenantDatabase>("TENANT_DB");

@Controller("/orders")
class OrderController {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDatabase) {}

  @Get("/mine")
  mine() {
    return { tenant: this.db.tenantId, orders: this.db.orders() };
  }
}

const OrderModule = defineModule({
  name: "OrderModule",
  imports: [DatabaseModule],
  providers: [
    {
      provide: TENANT_DB,
      // REQUEST is a built-in request-scoped token.
      useFactory: (req: Request, db: Database) =>
        db.forTenant(String(req.headers["x-tenant"] ?? "public")),
      inject: [REQUEST, Database],
      scope: "request",
    },
  ],
  controllers: [OrderController],
});

/* ================================================================== *
 * Root
 * ================================================================== */

const AppModule = defineModule({
  name: "AppModule",
  imports: [UserModule, OrderModule],
});

const app = express();
app.use(express.json());

const application = await createApplication(app, AppModule, {
  prefix: "/api",
});

printRoutes(application.routes);
console.log("\nmodules:", application.modules.join(" -> "));

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = isHttpError(err) ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    message: status === 500 ? "Internal server error" : err.message,
  });
};
app.use(errorHandler);

const server = app.listen(3001, () =>
  console.log("\nlistening on http://localhost:3001"),
);

// Graceful shutdown runs every onDispose() hook.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void application.close().then(() => process.exit(0));
    });
  });
}
