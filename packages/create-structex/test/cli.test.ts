import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STRUCTEX_CLI_TEST = "1";

const { main, runCreate, runGenerate } = await import("../src/index.js");
const { buildGeneratorFiles, buildProjectFiles } = await import(
  "../src/templates.js"
);
const { toCamel, toKebab, toPascal } = await import("../src/util.js");

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "structex-cli-"));
  process.chdir(workspace);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

describe("naming helpers", () => {
  it.each([
    ["user-profile", "user-profile"],
    ["userProfile", "user-profile"],
    ["UserProfile", "user-profile"],
    ["user profile", "user-profile"],
    ["user_profile", "user-profile"],
  ])("toKebab(%s) -> %s", (input, expected) => {
    expect(toKebab(input)).toBe(expected);
  });

  it("converts to Pascal and camel", () => {
    expect(toPascal("order-items")).toBe("OrderItems");
    expect(toCamel("order-items")).toBe("orderItems");
    expect(toPascal("orders")).toBe("Orders");
  });
});

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

describe("project templates", () => {
  it("produces the modules layout", () => {
    const files = buildProjectFiles({
      name: "my-api",
      template: "modules",
      structexVersion: "^0.5.0",
    });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "src/main.ts",
        "src/app.module.ts",
        "src/users/users.module.ts",
        "src/users/users.service.ts",
        "test/users.test.ts",
      ]),
    );
  });

  it("produces the minimal layout without modules", () => {
    const files = buildProjectFiles({
      name: "my-api",
      template: "minimal",
      structexVersion: "^0.5.0",
    });
    expect(files["src/users.controller.ts"]).toBeDefined();
    expect(files["src/app.module.ts"]).toBeUndefined();
  });

  it("always enables experimentalDecorators", () => {
    for (const template of ["minimal", "modules"] as const) {
      const files = buildProjectFiles({
        name: "x",
        template,
        structexVersion: "^0.5.0",
      });
      expect(files["tsconfig.json"]).toContain('"experimentalDecorators": true');
      expect(files["vitest.config.ts"]).toContain("experimentalDecorators");
    }
  });

  it("writes a valid package.json depending on structex", () => {
    const files = buildProjectFiles({
      name: "My API",
      template: "modules",
      structexVersion: "^0.5.0",
    });
    const parsed = JSON.parse(files["package.json"]!);
    expect(parsed.name).toBe("my-api");
    expect(parsed.dependencies.structex).toBe("^0.5.0");
    expect(parsed.dependencies.express).toBeDefined();
    expect(parsed.type).toBe("module");
  });

  it("imports every generated module in the root module", () => {
    const files = buildProjectFiles({
      name: "x",
      template: "modules",
      structexVersion: "^0.5.0",
    });
    const root = files["src/app.module.ts"]!;

    // Any module file the template writes must actually be wired up,
    // otherwise the scaffold ships dead code.
    const moduleFiles = Object.keys(files).filter(
      (path) => path.endsWith(".module.ts") && path !== "src/app.module.ts",
    );
    expect(moduleFiles.length).toBeGreaterThan(0);

    for (const path of moduleFiles) {
      const exported = /export const (\w+Module)/.exec(files[path]!)?.[1];
      expect(exported, `${path} exports a module`).toBeDefined();
      expect(root, `${exported} is imported by AppModule`).toContain(exported!);
    }
  });

  it("uses .js extensions in relative imports for NodeNext ESM", () => {
    const files = buildProjectFiles({
      name: "x",
      template: "modules",
      structexVersion: "^0.5.0",
    });
    const relativeImports =
      files["src/main.ts"]!.match(/from "\.\/[^"]+"/g) ?? [];
    expect(relativeImports.length).toBeGreaterThan(0);
    for (const statement of relativeImports) {
      expect(statement).toMatch(/\.js"$/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Generators
 * ------------------------------------------------------------------ */

describe("generators", () => {
  it("names files and classes consistently", () => {
    const files = buildGeneratorFiles("controller", "orderItems");
    expect(Object.keys(files)).toEqual(["order-items.controller.ts"]);
    expect(files["order-items.controller.ts"]).toContain(
      "export class OrderItemsController",
    );
    expect(files["order-items.controller.ts"]).toContain('@Controller("/order-items")');
  });

  it("generates a full resource triple", () => {
    const files = buildGeneratorFiles("resource", "orders");
    expect(Object.keys(files).sort()).toEqual([
      "orders.controller.ts",
      "orders.module.ts",
      "orders.service.ts",
    ]);
    expect(files["orders.module.ts"]).toContain("OrdersService");
    expect(files["orders.controller.ts"]).toContain("@Inject(OrdersService)");
  });

  it("imports from the right subpaths", () => {
    expect(buildGeneratorFiles("guard", "admin")["admin.guard.ts"]).toContain(
      'from "structex"',
    );
    expect(
      buildGeneratorFiles("pipe", "slug")["slug.pipe.ts"],
    ).toContain('from "structex/pipes"');
    expect(
      buildGeneratorFiles("interceptor", "audit")["audit.interceptor.ts"],
    ).toContain('from "structex/interceptors"');
    expect(
      buildGeneratorFiles("service", "orders")["orders.service.ts"],
    ).toContain('from "structex"');
  });
});

/* ------------------------------------------------------------------ *
 * runCreate
 * ------------------------------------------------------------------ */

describe("runCreate", () => {
  const base = {
    template: "modules" as const,
    install: false,
    git: false,
    force: false,
    packageManager: "npm" as const,
  };

  it("writes a project to disk", () => {
    runCreate({ ...base, directory: "my-api" });
    expect(existsSync(join(workspace, "my-api/package.json"))).toBe(true);
    expect(existsSync(join(workspace, "my-api/src/main.ts"))).toBe(true);
    expect(existsSync(join(workspace, "my-api/src/users/users.service.ts"))).toBe(
      true,
    );
  });

  it("refuses a non-empty directory without --force", () => {
    runCreate({ ...base, directory: "my-api" });
    expect(() => runCreate({ ...base, directory: "my-api" })).toThrow(
      /already exists and is not empty/,
    );
  });

  it("allows a non-empty directory with --force", () => {
    runCreate({ ...base, directory: "my-api" });
    expect(() =>
      runCreate({ ...base, directory: "my-api", force: true }),
    ).not.toThrow();
  });

  it("rejects an invalid project name", () => {
    expect(() => runCreate({ ...base, directory: "!!bad!!" })).toThrow(
      /Invalid project name/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * runGenerate
 * ------------------------------------------------------------------ */

describe("runGenerate", () => {
  beforeEach(() => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "app", dependencies: { structex: "^0.5.0" } }),
    );
  });

  it("writes a resource into src/<name>/", () => {
    runGenerate({ kind: "resource", name: "orders", flat: false, force: false });
    expect(existsSync(join(workspace, "src/orders/orders.module.ts"))).toBe(true);
    expect(existsSync(join(workspace, "src/orders/orders.service.ts"))).toBe(true);
  });

  it("writes a single controller flat into src/", () => {
    runGenerate({ kind: "controller", name: "health", flat: false, force: false });
    expect(existsSync(join(workspace, "src/health.controller.ts"))).toBe(true);
  });

  it("honours --dir", () => {
    runGenerate({
      kind: "guard",
      name: "admin",
      dir: "src/common",
      flat: true,
      force: false,
    });
    expect(existsSync(join(workspace, "src/common/admin.guard.ts"))).toBe(true);
  });

  it("never overwrites an existing file without --force", () => {
    runGenerate({ kind: "service", name: "orders", flat: true, force: false });
    const target = join(workspace, "src/orders.service.ts");
    writeFileSync(target, "// my code");

    runGenerate({ kind: "service", name: "orders", flat: true, force: false });
    expect(readFileSync(target, "utf8")).toBe("// my code");

    runGenerate({ kind: "service", name: "orders", flat: true, force: true });
    expect(readFileSync(target, "utf8")).not.toBe("// my code");
  });
});

/* ------------------------------------------------------------------ *
 * main()
 * ------------------------------------------------------------------ */

describe("main", () => {
  it("prints help and exits 0 with --help", () => {
    expect(main(["--help"])).toBe(0);
  });

  it("exits 1 with no arguments", () => {
    expect(main([])).toBe(1);
  });

  it("prints the version", () => {
    expect(main(["--version"])).toBe(0);
  });

  it("rejects an unknown template", () => {
    expect(main(["my-api", "--template", "nope", "--no-install"])).toBe(1);
  });

  it("rejects an unknown generator kind", () => {
    expect(main(["g", "nonsense", "orders"])).toBe(1);
  });

  it("requires both kind and name for generate", () => {
    expect(main(["g", "controller"])).toBe(1);
  });

  it("scaffolds through the argv path", () => {
    expect(main(["my-api", "--no-install", "--no-git"])).toBe(0);
    expect(existsSync(join(workspace, "my-api/src/main.ts"))).toBe(true);
  });

  it("parses --no-install and --no-git without erroring", () => {
    // node:util parseArgs has no built-in negation; these must be declared.
    expect(main(["a", "--no-install"])).toBe(0);
    expect(main(["b", "--no-install", "--no-git"])).toBe(0);
    expect(main(["c", "--no-install", "--template", "minimal"])).toBe(0);
    expect(existsSync(join(workspace, "c/src/users.controller.ts"))).toBe(true);
  });

  it("accepts the g alias", () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { structex: "^0.5.0" } }),
    );
    expect(main(["g", "controller", "orders"])).toBe(0);
    expect(existsSync(join(workspace, "src/orders.controller.ts"))).toBe(true);
  });
});
