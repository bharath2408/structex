import { BadRequest } from "./errors.js";
import type { Pipe, PipeMeta } from "./metadata.js";

const label = (meta: PipeMeta): string => meta.key ?? meta.type;

/** Rejects `undefined`, `null`, and `""` with 400. */
export const required: Pipe<unknown, unknown> = (value, meta) => {
  if (value === undefined || value === null || value === "") {
    throw BadRequest(`${label(meta)} is required`);
  }
  return value;
};

/** Substitutes a fallback when the value is `undefined` or `null`. */
export const defaultTo =
  <T>(fallback: T): Pipe<T | null | undefined, T> =>
  (value) =>
    value ?? fallback;

/** Trims strings; passes anything else through untouched. */
export const trim: Pipe<unknown, unknown> = (value) =>
  typeof value === "string" ? value.trim() : value;

/** Parses to a finite number. Passes `undefined` through. */
export const toNumber: Pipe<unknown, number | undefined> = (value, meta) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw BadRequest(`${label(meta)} must be a number`);
  }
  return parsed;
};

/** Parses to an integer. Passes `undefined` through. */
export const toInt: Pipe<unknown, number | undefined> = (value, meta) => {
  const parsed = toNumber(value, meta);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw BadRequest(`${label(meta)} must be an integer`);
  }
  return parsed;
};

/** Accepts `true/false/1/0/yes/no/on/off` (case-insensitive). */
export const toBoolean: Pipe<unknown, boolean | undefined> = (value, meta) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw BadRequest(`${label(meta)} must be a boolean`);
};

/** Clamps a number into a range. Passes `undefined` through. */
export const clamp =
  (min: number, max: number): Pipe<number | undefined, number | undefined> =>
  (value) =>
    value === undefined ? undefined : Math.min(max, Math.max(min, value));

/** Rejects values outside an allow-list. */
export const oneOf =
  <T extends string>(...allowed: T[]): Pipe<unknown, T | undefined> =>
  (value, meta) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (!allowed.includes(value as T)) {
      throw BadRequest(`${label(meta)} must be one of: ${allowed.join(", ")}`);
    }
    return value as T;
  };

/**
 * Adapts any parser exposing a Standard-Schema-like `safeParse`
 * (zod, valibot, arktype) without this package depending on it.
 *
 * ```ts
 * @Body(parseWith(CreateUserSchema)) dto: CreateUserDto
 * ```
 */
export function parseWith<Out>(schema: {
  safeParse: (
    value: unknown,
  ) => { success: true; data: Out } | { success: false; error: unknown };
}): Pipe<unknown, Out> {
  return (value, meta) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const error = result.error as { flatten?: () => unknown };
      throw BadRequest(
        `Validation failed for ${label(meta)}`,
        typeof error?.flatten === "function" ? error.flatten() : error,
      );
    }
    return result.data;
  };
}
