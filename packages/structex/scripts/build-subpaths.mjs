/**
 * Generates subpath entry points (structex/di, structex/pipes, ...).
 *
 * These are thin re-export shims over the single `index` bundle rather than
 * separate bundles. That is deliberate: bundling each subpath independently
 * would duplicate the module-level `WeakMap` metadata store, so a decorator
 * imported from `structex` would write to a different store than the one
 * `registerControllers` imported from `structex/di` reads. Shims guarantee
 * exactly one instance of every module.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

/** @type {{ name: string, values: string[], types: string[] }[]} */
const SUBPATHS = [
  {
    name: "di",
    values: [
      "token",
      "Inject",
      "isInjectionToken",
      "getConstructorDeps",
      "normalizeProvider",
      "createRequestScope",
      "Container",
      "DependencyError",
      "REQUEST",
      "RESPONSE",
      "defineModule",
      "isModuleRef",
      "createApplication",
      "forwardRef",
      "optional",
      "isForwardRef",
      "isOptionalDep",
      "disposeRequestScope",
    ],
    types: [
      "InjectionToken",
      "ProviderToken",
      "Provider",
      "ValueProvider",
      "ClassProvider",
      "FactoryProvider",
      "ExistingProvider",
      "Scope",
      "Dependency",
      "ForwardRef",
      "OptionalDep",
      "RequestScope",
      "OnModuleInit",
      "OnDispose",
      "ModuleDefinition",
      "ModuleRef",
      "ApplicationOptions",
      "ApplicationRef",
    ],
  },
  {
    name: "pipes",
    values: [
      "required",
      "defaultTo",
      "trim",
      "toNumber",
      "toInt",
      "toBoolean",
      "clamp",
      "oneOf",
      "parseWith",
    ],
    types: ["Pipe", "PipeMeta"],
  },
  {
    name: "interceptors",
    values: ["timing", "timeout", "cache", "retry", "envelope"],
    types: ["Interceptor", "ExecutionContext", "CacheOptions", "RetryOptions"],
  },
  {
    name: "openapi",
    values: ["toOpenApi", "toOpenApiPath"],
    types: ["OpenApiInfo", "OpenApiOptions", "ApiDocDefinition"],
  },
  {
    name: "serialization",
    values: ["Exclude", "Expose", "Transform", "serialize", "resolveRules"],
    types: ["ExposeOptions", "FieldRule", "SerializeContext", "SerializeGroups"],
  },
  {
    name: "testing",
    values: ["createTestApp"],
    types: ["TestApp", "TestAppOptions"],
  },
];

/** Runtime ESM shim. Values only — `export type` is not valid JavaScript. */
function esm({ values }) {
  if (!values.length) return "export {};\n";
  return `export { ${values.join(", ")} } from "./index.js";\n`;
}

function cjs({ values }) {
  return [
    `"use strict";`,
    `const shared = require("./index.cjs");`,
    `module.exports = {`,
    ...values.map((name) => `  ${name}: shared.${name},`),
    `};`,
    ``,
  ].join("\n");
}

function dts({ values, types }, from) {
  const lines = [];
  if (values.length) {
    lines.push(`export { ${values.join(", ")} } from "${from}";`);
  }
  if (types.length) {
    lines.push(`export type { ${types.join(", ")} } from "${from}";`);
  }
  return `${lines.join("\n")}\n`;
}

let written = 0;
for (const subpath of SUBPATHS) {
  writeFileSync(join(DIST, `${subpath.name}.js`), esm(subpath));
  writeFileSync(join(DIST, `${subpath.name}.cjs`), cjs(subpath));
  writeFileSync(join(DIST, `${subpath.name}.d.ts`), dts(subpath, "./index.js"));
  writeFileSync(
    join(DIST, `${subpath.name}.d.cts`),
    dts(subpath, "./index.cjs"),
  );
  written += 4;
}

console.log(
  `subpaths: ${written} files for ${SUBPATHS.map((s) => s.name).join(", ")}`,
);
