import type { Request } from "express";

/**
 * Response serialization.
 *
 * The problem this solves: returning a domain object straight from a handler
 * sends every field on it, including `passwordHash`. Marking fields with
 * `@Exclude()` makes omission the default rather than something you have to
 * remember at each call site.
 *
 * Rules live on the class, so this only applies to **class instances**. Plain
 * objects pass through untouched — if your repository returns row objects,
 * map them into a class first or the rules will not fire.
 */

export interface ExposeOptions {
  /** Rename the field in the response. */
  name?: string;
  /**
   * Only include the field when one of these groups is active. Omit to
   * always include.
   */
  groups?: string[];
}

export interface FieldRule {
  exclude: boolean;
  name?: string;
  groups?: string[];
  transform?: (value: unknown, instance: unknown) => unknown;
}

const rules = new WeakMap<Function, Map<string, FieldRule>>();

/**
 * True once any `@Exclude`/`@Expose`/`@Transform` decorator has run,
 * anywhere in the process. Lets `serialize()` short-circuit to a true no-op
 * for apps that never use these decorators, instead of deep-cloning every
 * response body on every request just to find nothing to do.
 */
let hasAnyRules = false;

function rulesFor(target: Function): Map<string, FieldRule> {
  let map = rules.get(target);
  if (!map) {
    map = new Map();
    rules.set(target, map);
  }
  return map;
}

/**
 * Legacy decorators pass the prototype as `target`; TypeScript's standard
 * (Stage 3) decorators pass a context object instead, which would fail later
 * with an opaque `Cannot read properties of undefined`. Fail loudly here with
 * the actual fix instead.
 */
function assertLegacyDecorators(target: unknown, decorator: string): void {
  if (target === undefined || target === null) {
    throw new Error(
      `structex: @${decorator}() requires "experimentalDecorators": true in ` +
        `tsconfig.json.\n` +
        `  TypeScript's standard decorators do not support the parameter and ` +
        `property decorators structex uses.\n` +
        `  If you build with esbuild, tsup, SWC, or Vitest, that setting must ` +
        `reach the transform too — see the Bundlers section of the README.`,
    );
  }
}

function updateRule(
  target: object,
  propertyKey: string | symbol,
  patch: Partial<FieldRule>,
  decorator: string,
): void {
  assertLegacyDecorators(target, decorator);
  const ctor = target.constructor;
  const map = rulesFor(ctor);
  const key = String(propertyKey);
  map.set(key, { exclude: false, ...map.get(key), ...patch });
  hasAnyRules = true;
}

export { assertLegacyDecorators };

/**
 * Rules for a class including those inherited from decorated base classes.
 * Returns `undefined` when nothing in the chain is decorated.
 */
export function resolveRules(
  target: Function,
): Map<string, FieldRule> | undefined {
  const chain: Function[] = [];
  let current: Function | null = target;

  while (current && current !== Function.prototype) {
    if (rules.has(current)) chain.unshift(current);
    current = Object.getPrototypeOf(current) as Function | null;
  }
  if (chain.length === 0) return undefined;

  const merged = new Map<string, FieldRule>();
  for (const cls of chain) {
    for (const [key, rule] of rules.get(cls)!) {
      merged.set(key, { ...merged.get(key), ...rule });
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * Property decorators
 * ------------------------------------------------------------------ */

/** Omits the field from serialized responses. */
export function Exclude(): PropertyDecorator {
  return (target, propertyKey) => {
    updateRule(target, propertyKey, { exclude: true }, "Exclude");
  };
}

/** Renames a field, or restricts it to named groups. */
export function Expose(options: ExposeOptions = {}): PropertyDecorator {
  return (target, propertyKey) => {
    updateRule(
      target,
      propertyKey,
      { exclude: false, name: options.name, groups: options.groups },
      "Expose",
    );
  };
}

/** Maps a field's value on the way out. */
export function Transform(
  fn: (value: unknown, instance: unknown) => unknown,
): PropertyDecorator {
  return (target, propertyKey) => {
    updateRule(target, propertyKey, { transform: fn }, "Transform");
  };
}

/* ------------------------------------------------------------------ *
 * Serializer
 * ------------------------------------------------------------------ */

export interface SerializeContext {
  groups: string[];
}

const PASSTHROUGH = new Set(["Date", "RegExp"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Applies serialization rules to a value, recursing through arrays, plain
 * objects, and nested class instances.
 *
 * Values with no decorated class are returned unchanged, so this is a no-op
 * until you actually mark a field.
 */
export function serialize(
  value: unknown,
  context: SerializeContext = { groups: [] },
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (!hasAnyRules) return value;
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return undefined; // cycle
  if (Buffer.isBuffer(value)) return value;

  const name = value.constructor?.name;
  if (name && PASSTHROUGH.has(name)) return value;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => serialize(item, context, seen));
    }

    if (isPlainObject(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = serialize(item, context, seen);
      }
      return output;
    }

    const fieldRules = resolveRules(value.constructor);
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      const rule = fieldRules?.get(key);

      if (rule?.exclude) continue;
      if (
        rule?.groups?.length &&
        !rule.groups.some((group) => context.groups.includes(group))
      ) {
        continue;
      }

      const transformed = rule?.transform ? rule.transform(item, value) : item;
      output[rule?.name ?? key] = serialize(transformed, context, seen);
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

/** Resolves the active groups for a request. */
export type SerializeGroups = string[] | ((req: Request) => string[]);

export function resolveGroups(
  groups: SerializeGroups | undefined,
  req: Request,
): string[] {
  if (!groups) return [];
  return typeof groups === "function" ? groups(req) : groups;
}
