import { describe, expect, it } from "vitest";
import { serialize } from "../src/serialization.js";

/**
 * This file deliberately never imports @Exclude/@Expose/@Transform, so
 * `serialize()`'s `hasAnyRules` flag stays false for its entire run —
 * exercising the true no-op fast path (see serialization.ts), not the
 * decorated-class path already covered by gaps.test.ts.
 */
describe("serialize() with zero decorators registered anywhere", () => {
  it("returns the exact same object reference, not a clone", () => {
    const input = { a: 1, nested: { b: 2 } };
    expect(serialize(input)).toBe(input);
    expect((serialize(input) as typeof input).nested).toBe(input.nested);
  });

  it("returns the exact same array reference, not a clone", () => {
    const input = [{ a: 1 }, { b: 2 }];
    expect(serialize(input)).toBe(input);
  });

  it("returns a genuinely circular plain object unchanged rather than breaking the cycle", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    const output = serialize(node) as Record<string, unknown>;
    expect(output).toBe(node);
    expect(output.self).toBe(node); // not silently replaced with undefined
  });

  it("still passes primitives through", () => {
    expect(serialize("x")).toBe("x");
    expect(serialize(null)).toBe(null);
    expect(serialize(42)).toBe(42);
  });
});
