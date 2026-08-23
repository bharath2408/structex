import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

import {
  GENERATOR_KINDS,
  buildGeneratorFiles,
  buildProjectFiles,
  type GeneratorKind,
  type TemplateName,
} from "./templates.js";
import {
  CliError,
  assertValidName,
  blue,
  bold,
  brightCyan,
  brightMagenta,
  cyan,
  dim,
  green,
  info,
  red,
  success,
  toKebab,
  toPascal,
  warn,
  writeFiles,
  yellow,
} from "./util.js";

const VERSION = "0.5.2";
/** Kept in step with the CLI's own major.minor. */
const STRUCTEX_VERSION = "^0.5.0";

const TEMPLATES: TemplateName[] = ["minimal", "modules"];
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/* ------------------------------------------------------------------ *
 * Help
 * ------------------------------------------------------------------ */

function printHelp(): void {
  info(`
${brightMagenta("◆")} ${bold(brightCyan("structex"))} ${dim(`v${VERSION}`)} — structure for Express

${bold(brightMagenta("Create a project"))}
  npx create-structex <directory> [options]

  ${cyan("--template <name>")}   ${TEMPLATES.join(" | ")}   ${dim("(default: modules)")}
  ${cyan("--pm <manager>")}      npm | pnpm | yarn | bun
  ${cyan("--no-install")}        skip dependency installation
  ${cyan("--no-git")}            skip git init
  ${cyan("--force")}             write into a non-empty directory

${bold(brightMagenta("Generate code"))}
  npx structex generate <kind> <name> [options]
  npx structex g <kind> <name>

  kinds: ${GENERATOR_KINDS.join(", ")}

  ${cyan("--dir <path>")}        target directory ${dim("(default: src/<name> in a module project)")}
  ${cyan("--flat")}              write into --dir directly, no subfolder
  ${cyan("--force")}             overwrite existing files

${bold(brightMagenta("Examples"))}
  ${dim("$")} ${cyan("npx create-structex my-api")}
  ${dim("$")} ${cyan("npx create-structex my-api --template minimal --no-install")}
  ${dim("$")} ${cyan("npx structex g resource orders")}
  ${dim("$")} ${cyan("npx structex g guard admin --dir src/common --flat")}
`);
}

/* ------------------------------------------------------------------ *
 * Package manager
 * ------------------------------------------------------------------ */

function detectPackageManager(): PackageManager {
  // npm_config_user_agent is set by whichever manager invoked us.
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

function runInstall(cwd: string, manager: PackageManager): boolean {
  try {
    // On Windows, npm/pnpm/yarn/bun are .cmd shims that execFileSync can't
    // resolve without a shell — ENOENT otherwise, even though the same
    // command works fine typed into any terminal.
    execFileSync(manager, ["install"], {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    warn(`${manager} install failed — run it yourself once the network is up.`);
    return false;
  }
}

function initGit(cwd: string): boolean {
  try {
    execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * create
 * ------------------------------------------------------------------ */

interface CreateOptions {
  directory: string;
  template: TemplateName;
  install: boolean;
  git: boolean;
  force: boolean;
  packageManager: PackageManager;
}

export function runCreate(options: CreateOptions): void {
  const {
    directory,
    template,
    install,
    git,
    force,
    packageManager,
  } = options;

  const root = resolve(process.cwd(), directory);
  const name = directory === "." ? "app" : directory.split(/[\\/]/).pop()!;
  assertValidName(name, "project name");

  if (existsSync(root) && readdirSync(root).length > 0 && !force) {
    throw new CliError(
      `${directory} already exists and is not empty. Pass --force to write into it anyway.`,
    );
  }

  const files = buildProjectFiles({
    name,
    template,
    structexVersion: STRUCTEX_VERSION,
  });

  const { written, skipped } = writeFiles(root, files, { force });

  info("");
  info(
    `${brightMagenta("◆")} ${bold(brightCyan(toKebab(name)))} ${dim(`— ${template} template`)}`,
  );
  info("");
  for (const file of written) info(`  ${green("+")} ${file}`);
  for (const file of skipped) info(`  ${yellowSkip(file)}`);

  if (git && initGit(root)) info(`\n  ${blue("⎇")}  ${dim("initialized git repository")}`);

  let installed = false;
  if (install) {
    info(`\n  ${dim(`installing with ${packageManager}…`)}\n`);
    installed = runInstall(root, packageManager);
  }

  const run = packageManager === "npm" ? "npm run" : packageManager;
  info(`
${bold(brightMagenta("Next steps"))}

  ${cyan(`cd ${directory}`)}${installed ? "" : `\n  ${cyan(`${packageManager} install`)}`}
  ${cyan(`${run} dev`)}

${dim("Then:")} ${bold("curl localhost:3000/api/users")}
`);
  success(`Ready — happy building with ${bold(brightCyan("structex"))}!`);
}

function yellowSkip(file: string): string {
  return `${yellow("·")} ${file} ${dim("(exists, skipped)")}`;
}

/* ------------------------------------------------------------------ *
 * generate
 * ------------------------------------------------------------------ */

interface GenerateOptions {
  kind: GeneratorKind;
  name: string;
  dir?: string;
  flat: boolean;
  force: boolean;
}

/** True when the cwd looks like a Structex project. */
function looksLikeProject(cwd: string): boolean {
  const manifest = join(cwd, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      parsed.dependencies?.["@bharath2408/structex"] ??
        parsed.devDependencies?.["@bharath2408/structex"],
    );
  } catch {
    return false;
  }
}

export function runGenerate(options: GenerateOptions): void {
  const { kind, name, dir, flat, force } = options;
  assertValidName(name, "name");

  const cwd = process.cwd();
  if (!looksLikeProject(cwd)) {
    warn(
      "No @bharath2408/structex dependency found in package.json — generating anyway, but check you are in the right directory.",
    );
  }

  const kebab = toKebab(name);
  const base = dir ?? "src";
  // A resource is a folder; single files land beside their siblings.
  const useSubfolder = !flat && !dir && (kind === "resource" || kind === "module");
  const target = resolve(cwd, useSubfolder ? join(base, kebab) : base);

  const files = buildGeneratorFiles(kind, name);
  const { written, skipped } = writeFiles(target, files, { force });

  info("");
  if (written.length === 0) {
    warn("Nothing written — every file already exists. Pass --force to overwrite.");
  } else {
    success(`Generated ${bold(kind)} ${brightCyan(toPascal(name))}`);
  }

  const prefix = useSubfolder ? `${base}/${kebab}/` : `${base}/`;
  for (const file of written) info(`  ${green("+")} ${prefix}${file}`);
  for (const file of skipped) info(`  ${yellowSkip(`${prefix}${file}`)}`);

  printWiringHint(kind, name);
}

/**
 * Wiring is printed rather than auto-edited: rewriting a user's module file by
 * string manipulation is fragile, and a wrong edit is worse than a reminder.
 */
function printWiringHint(kind: GeneratorKind, name: string): void {
  const Pascal = toPascal(name);
  const kebab = toKebab(name);

  const hint = (() => {
    switch (kind) {
      case "resource":
        return `Register it in your root module:

  ${dim("// src/app.module.ts")}
  import { ${Pascal}Module } from "./${kebab}/${kebab}.module.js";

  export const AppModule = defineModule({
    imports: [${Pascal}Module],
  });`;
      case "module":
        return `Add it to a parent module's ${cyan("imports")}.`;
      case "controller":
        return `Add ${cyan(`${Pascal}Controller`)} to a module's ${cyan("controllers")},
  or pass it to ${cyan("registerControllers")}.`;
      case "service":
        return `Add ${cyan(`${Pascal}Service`)} to a module's ${cyan("providers")}
  (and ${cyan("exports")} if other modules need it).`;
      case "guard":
        return `Apply it: ${cyan(`@UseGuards(${lower(Pascal)}Guard)`)}`;
      case "interceptor":
        return `Apply it: ${cyan(`@UseInterceptors(${lower(Pascal)}Interceptor)`)}`;
      case "pipe":
        return `Apply it: ${cyan(`@Body("field", ${lower(Pascal)}Pipe)`)}`;
    }
  })();

  info(`\n${bold(brightMagenta("Next"))}\n  ${hint}\n`);
}

function lower(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        template: { type: "string", short: "t" },
        dir: { type: "string", short: "d" },
        pm: { type: "string" },
        flat: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        // node:util parseArgs has no --no-x negation, so declare them.
        "no-install": { type: "boolean", default: false },
        "no-git": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    console.error(`${red("✖")} ${(err as Error).message}`);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    info(VERSION);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    printHelp();
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  try {
    const [first, ...rest] = positionals;

    if (first === "generate" || first === "g") {
      const [kind, name] = rest;
      if (!kind || !name) {
        throw new CliError(
          `Usage: structex g <kind> <name>\n  kinds: ${GENERATOR_KINDS.join(", ")}`,
        );
      }
      if (!GENERATOR_KINDS.includes(kind as GeneratorKind)) {
        throw new CliError(
          `Unknown kind ${JSON.stringify(kind)}. Expected one of: ${GENERATOR_KINDS.join(", ")}`,
        );
      }
      runGenerate({
        kind: kind as GeneratorKind,
        name,
        dir: values.dir,
        flat: values.flat ?? false,
        force: values.force ?? false,
      });
      return 0;
    }

    const template = (values.template ?? "modules") as TemplateName;
    if (!TEMPLATES.includes(template)) {
      throw new CliError(
        `Unknown template ${JSON.stringify(template)}. Expected one of: ${TEMPLATES.join(", ")}`,
      );
    }

    const packageManager = (values.pm ?? detectPackageManager()) as PackageManager;

    runCreate({
      directory: first!,
      template,
      install: !values["no-install"],
      git: !values["no-git"],
      force: values.force ?? false,
      packageManager,
    });
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`\n${red("✖")} ${err.message}\n`);
      return 1;
    }
    console.error(`\n${red("✖")} ${(err as Error).message}\n`);
    return 1;
  }
}

// Only auto-run as a binary, so tests can import main() directly.
if (process.argv[1] && !process.env.STRUCTEX_CLI_TEST) {
  process.exit(main(process.argv.slice(2)));
}
