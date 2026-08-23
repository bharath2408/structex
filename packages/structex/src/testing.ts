import type {
  ErrorRequestHandler,
  Express,
  Request,
  RequestHandler,
} from "express";
import { isHttpError } from "./errors.js";
import {
  registerControllers,
  type ControllerInput,
  type RegisterOptions,
  type RouteInfo,
} from "./register.js";

export interface TestAppOptions extends RegisterOptions {
  /**
   * Express itself. Passed in so this package keeps a type-only dependency on
   * Express and never pulls a second copy into your tests.
   */
  express: () => Express;
  /** Middleware to run before the controllers, e.g. a fake auth layer. */
  middleware?: RequestHandler[];
  /**
   * Shorthand for injecting a fake authenticated user. Sets `req.user` and
   * runs before `middleware`.
   */
  user?: unknown;
  /** Parse JSON request bodies. Default `true`. */
  json?: boolean;
  /**
   * Error handler mounted after the controllers. Defaults to a JSON envelope
   * that reads `status` off `HttpError`.
   */
  errorHandler?: ErrorRequestHandler;
}

export interface TestApp {
  app: Express;
  routes: RouteInfo[];
}

const defaultErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = isHttpError(err) ? err.status : 500;
  res.status(status).json({
    message: status === 500 ? "Internal server error" : err.message,
    ...(isHttpError(err) && err.details !== undefined
      ? { details: err.details }
      : {}),
  });
};

/**
 * Builds a minimal Express app around one or more controllers, so a controller
 * can be tested in isolation without duplicating your bootstrap.
 *
 * ```ts
 * import express from "express";
 * import request from "supertest";
 * import { createTestApp } from "structex/testing";
 *
 * const { app } = createTestApp([new UserController(fakeRepo)], {
 *   express,
 *   user: { id: "u_1", role: "admin" },
 * });
 *
 * await request(app).get("/users/u_1").expect(200);
 * ```
 */
export function createTestApp(
  controllers: ControllerInput[],
  options: TestAppOptions,
): TestApp {
  const {
    express: createExpress,
    middleware = [],
    user,
    json = true,
    errorHandler = defaultErrorHandler,
    ...registerOptions
  } = options;

  const app = createExpress();
  const expressModule = createExpress as unknown as {
    json?: () => RequestHandler;
  };

  if (json && typeof expressModule.json === "function") {
    app.use(expressModule.json());
  }

  if (user !== undefined) {
    app.use((req: Request, _res, next) => {
      (req as Request & { user?: unknown }).user = user;
      next();
    });
  }

  for (const handler of middleware) app.use(handler);

  const routes = registerControllers(app, controllers, registerOptions);
  app.use(errorHandler);

  return { app, routes };
}
