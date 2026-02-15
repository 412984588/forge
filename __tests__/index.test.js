import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import register, { __testing } from "../index.js";

describe("forge internals", () => {
  test("runCommand executes asynchronously and returns stdout", async () => {
    const result = await __testing.runCommand('node -e "console.log(123)"', {
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("123");
  });

  test("LRU cache evicts least recently used entry", () => {
    const cache = new __testing.LRUCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("rate limiter blocks requests over threshold", () => {
    const limiter = new __testing.RateLimiter({ limit: 2, windowMs: 10_000 });
    expect(limiter.consume("forge_status")).toBe(true);
    expect(limiter.consume("forge_status")).toBe(true);
    expect(limiter.consume("forge_status")).toBe(false);
  });

  test("input whitelist rejects invalid branch names", () => {
    const validation = __testing.validateToolParams("forge_git", {
      projectId: "proj-1",
      action: "branch",
      branch: "bad;rm -rf /",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("branch");
  });

  test("normalizeErrorResult adds standard error shape", () => {
    const normalized = __testing.normalizeErrorResult({
      success: false,
      error: "Missing projectId",
    });
    expect(normalized.errorCode).toBeDefined();
    expect(normalized.suggestion).toBeDefined();
  });

  test("incremental index detects changed files only", async () => {
    const fakeFs = {
      walkFiles: async () => [
        { relPath: "src/a.ts", mtimeMs: 1, size: 10 },
        { relPath: "src/b.ts", mtimeMs: 2, size: 20 },
      ],
      previousState: new Map([["src/a.ts", "1:10"]]),
    };

    const result = await __testing.computeIncrementalChanges(
      fakeFs.walkFiles,
      fakeFs.previousState,
    );
    expect(result.changed).toEqual(["src/b.ts"]);
    expect(result.removed).toEqual([]);
  });

  test("forge_init succeeds for PRD with dependencies (no crash on array parse)", async () => {
    const tools = new Map();
    register({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (toolDef) => tools.set(toolDef.name, toolDef),
    });

    const prd = [
      "# Demo",
      "### Feature 1: Auth",
      "- 描述: login",
      "- 优先级: P1",
      "- 依赖: 无",
      "### Feature 2: Profile",
      "- 描述: profile page",
      "- 优先级: P1",
      "- 依赖: feat-001",
    ].join("\n");

    const result = await tools.get("forge_init").execute("t", { prd });
    expect(result.success).toBe(true);
    expect(result.projectId).toBeDefined();
  });

  test("forge_init can create two projects from same PRD without feature ID collision", async () => {
    const tools = new Map();
    register({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (toolDef) => tools.set(toolDef.name, toolDef),
    });
    const prd = [
      "# Collision Check",
      "### Feature 1: A",
      "- 描述: a",
      "- 优先级: P1",
      "- 依赖: 无",
      "### Feature 2: B",
      "- 描述: b",
      "- 优先级: P1",
      "- 依赖: feat-001",
    ].join("\n");

    const first = await tools.get("forge_init").execute("t1", { prd });
    const second = await tools.get("forge_init").execute("t2", { prd });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
  });

  test("input whitelist rejects unsafe package names", () => {
    const validation = __testing.validateToolParams("forge_install", {
      projectId: "proj-1",
      packages: ["lodash", "evil;rm -rf /"],
      dev: false,
    });
    expect(validation.valid).toBe(false);
  });

  test("state machine blocks invalid transition pending -> complete", () => {
    expect(__testing.isValidFeatureTransition("pending", "complete")).toBe(
      false,
    );
    expect(__testing.isValidFeatureTransition("pending", "in_progress")).toBe(
      true,
    );
  });
});
