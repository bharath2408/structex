import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

// Respect NO_COLOR and non-TTY output so piping stays clean.
const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");
export const red = wrap("31");

export function info(message: string): void {
  console.log(message);
}

export function success(message: string): void {
  console.log(`${green("✔")} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${yellow("!")} ${message}`);
}

export class CliError extends Error {}

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/** `user-profile`, `userProfile`, `UserProfile`, `user profile` -> `user-profile` */
export function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "");
}

/** -> `UserProfile` */
export function toPascal(input: string): string {
  return toKebab(input)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** -> `userProfile` */
export function toCamel(input: string): string {
  const pascal = toPascal(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Validates a name for use as a directory and package name.
 * Deliberately strict — a bad name surfaces as confusing npm errors later.
 */
export function assertValidName(name: string, what = "name"): void {
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new CliError(
      `Invalid ${what}: ${JSON.stringify(name)}. Use letters, digits, dots, dashes, or underscores.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

export interface WriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Writes files relative to `root`, never overwriting an existing file unless
 * `force` is set — clobbering a user's code is the one unrecoverable mistake
 * a generator can make.
 */
export function writeFiles(
  root: string,
  files: Record<string, string>,
  options: { force?: boolean } = {},
): WriteResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = resolve(root, relativePath);

    if (existsSync(target) && !options.force) {
      skipped.push(relativePath);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    written.push(relativePath);
  }

  return { written, skipped };
}

export function relativeFrom(root: string, target: string): string {
  const path = relative(root, target);
  return path.startsWith(".") ? path : `./${path}`;
}

export { join, resolve };
