import { describe, expect, it } from "vitest";
import { completeJsonBoundary } from "../src/json-boundary.js";

describe("completeJsonBoundary", () => {
  it("finds a complete object boundary after leading text", () => {
    expect(completeJsonBoundary('text before {"a":1} trailing')).toBe('text before {"a":1}'.length);
  });

  it("finds a complete array boundary", () => {
    expect(completeJsonBoundary('```json\n[{"x":true}]\n```')).toBe('```json\n[{"x":true}]'.length);
  });

  it("waits for nested structures to close", () => {
    expect(completeJsonBoundary('{"a":[{"b":"}"}]} more')).toBe('{"a":[{"b":"}"}]}'.length);
    expect(completeJsonBoundary('{"a":[1,2}')).toBeNull();
  });

  it("returns null for partial JSON", () => {
    expect(completeJsonBoundary('{"a":')).toBeNull();
    expect(completeJsonBoundary("no json")).toBeNull();
  });
});
