import { resolveMeta, type ApiDocDefinition } from "./metadata.js";
import { joinPaths, type ControllerInput } from "./register.js";

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiOptions {
  info: OpenApiInfo;
  servers?: { url: string; description?: string }[];
  /** Prepended to every path, matching `registerControllers`. */
  prefix?: string;
  /** Merged into the generated document — the place for `components`. */
  extra?: Record<string, unknown>;
}

/** Converts `/users/:id` to `/users/{id}` and returns the parameter names. */
export function toOpenApiPath(path: string): {
  path: string;
  params: string[];
} {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z0-9_]+)(\??)/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

/**
 * Generates an OpenAPI 3.1 skeleton from your declared routes.
 *
 * This is deliberately *not* inferred from TypeScript types — doing that would
 * require `reflect-metadata` and a schema library. Path parameters and
 * operation shape come from the routes; request/response schemas come from
 * whatever you supply via `@ApiDoc`.
 *
 * ```ts
 * const spec = toOpenApi([UserController], {
 *   info: { title: "API", version: "1.0.0" },
 *   prefix: "/api/v1",
 * });
 * app.get("/openapi.json", (_req, res) => res.json(spec));
 * ```
 */
export function toOpenApi(
  controllers: ControllerInput[],
  options: OpenApiOptions,
): Record<string, unknown> {
  const { info, servers, prefix = "", extra = {} } = options;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const input of controllers) {
    const ctor =
      typeof input === "function" ? input : (input as object).constructor;
    const meta = resolveMeta(ctor);
    if (!meta) continue;

    for (const route of meta.routes) {
      if (route.sse) continue; // not expressible as a JSON operation

      const raw = joinPaths(prefix, meta.prefix, route.path);
      const { path, params } = toOpenApiPath(raw);
      const doc: ApiDocDefinition = meta.apiDocs.get(route.handlerName) ?? {};

      const pathParams = params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));

      const operation: Record<string, unknown> = {
        operationId: doc.operationId ?? `${ctor.name}_${route.handlerName}`,
        tags: doc.tags ?? (meta.tags.length ? meta.tags : [ctor.name]),
        responses: doc.responses ?? {
          [String(route.method === "post" ? 201 : 200)]: {
            description: "Successful response",
          },
        },
      };

      if (doc.summary) operation.summary = doc.summary;
      if (doc.description) operation.description = doc.description;
      if (doc.deprecated) operation.deprecated = true;
      if (doc.requestBody) operation.requestBody = doc.requestBody;
      if (doc.security) operation.security = doc.security;

      const allParams = [...pathParams, ...(doc.parameters ?? [])];
      if (allParams.length) operation.parameters = allParams;

      paths[path] ??= {};
      paths[path]![route.method] = operation;
    }
  }

  return {
    openapi: "3.1.0",
    info,
    ...(servers ? { servers } : {}),
    paths,
    ...extra,
  };
}
