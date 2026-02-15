import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import sqlite3pkg from "sqlite3";
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

  test("input whitelist rejects unsafe repoName values", () => {
    const validation = __testing.validateToolParams("forge_push", {
      projectId: "proj-1",
      action: "status",
      repoName: "bad/repo;rm -rf /",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("repoName");
  });

  test("input whitelist rejects unsafe path values", () => {
    const validation = __testing.validateToolParams("forge_init", {
      projectId: "proj-1",
      path: "../secret",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("path");
  });

  test("input whitelist rejects unsafe testCommand content", () => {
    const validation = __testing.validateToolParams("forge_test", {
      projectId: "proj-1",
      testCommand: "npm test && rm -rf /",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("Unsafe");
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

  test("validateToolParams rejects non-array packages input", () => {
    const validation = __testing.validateToolParams("forge_install", {
      projectId: "proj-1",
      packages: "lodash",
      dev: false,
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("packages");
  });

  test("state machine blocks invalid transition pending -> complete", () => {
    expect(__testing.isValidFeatureTransition("pending", "complete")).toBe(
      false,
    );
    expect(__testing.isValidFeatureTransition("pending", "in_progress")).toBe(
      true,
    );
  });

  test("detectCycle is resilient to malformed dependencies payload", () => {
    const features = [
      { id: "a", dependencies: { bad: true } },
      { id: "b", dependencies: 123 },
    ];
    expect(() => __testing.detectCycle(features)).not.toThrow();
    expect(__testing.detectCycle(features)).toBe(false);
  });

  test("validateDependencies is resilient to non-array dependencies", () => {
    const features = [
      { id: "a", dependencies: "oops" },
      { id: "b", dependencies: null },
    ];
    expect(() => __testing.validateDependencies(features)).not.toThrow();
    expect(__testing.validateDependencies(features)).toEqual([]);
  });

  test("input whitelist rejects path traversal package names", () => {
    const validation = __testing.validateToolParams("forge_install", {
      projectId: "proj-1",
      packages: ["../evil", "@safe/pkg"],
      dev: true,
    });
    expect(validation.valid).toBe(false);
  });

  test("forge_status is isolated across projects", async () => {
    const tools = new Map();
    const originalHome = process.env.HOME;
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "forge-project-isolation-"),
    );
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".forge-state");

    try {
      register({
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: (toolDef) => tools.set(toolDef.name, toolDef),
      });

      const prdA = [
        "# Project A",
        "### Feature 1: A",
        "- 描述: alpha",
        "- 优先级: P1",
      ].join("\n");

      const prdB = [
        "# Project B",
        "### Feature 1: B1",
        "- 描述: beta",
        "- 优先级: P1",
        "### Feature 2: B2",
        "- 描述: beta2",
        "- 优先级: P1",
      ].join("\n");

      const first = await tools.get("forge_init").execute("t-a", { prd: prdA });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const second = await tools
        .get("forge_init")
        .execute("t-b", { prd: prdB });
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.projectId).not.toBe(first.projectId);

      const firstStatus = await tools
        .get("forge_status")
        .execute("t-a", { projectId: first.projectId });
      const secondStatus = await tools
        .get("forge_status")
        .execute("t-b", { projectId: second.projectId });
      expect(firstStatus.success).toBe(true);
      expect(secondStatus.success).toBe(true);
      expect(firstStatus.progress.total).toBe(1);
      expect(secondStatus.progress.total).toBe(2);
    } finally {
      process.env.HOME = originalHome;
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
      await fs.promises.rm(tempHome, { recursive: true, force: true });
    }
  });

  test("audit sanitizer redacts token/account/path fields", () => {
    const sanitized = __testing.sanitizeAuditValue({
      token: "abcd1234",
      account: "user@example.com",
      nested: { apiToken: "xyz", filePath: "/Users/alice/project" },
    });
    expect(sanitized.token).toMatch(/\[REDACTED/i);
    expect(sanitized.account).toMatch(/\[REDACTED/i);
    expect(sanitized.nested.apiToken).toMatch(/\[REDACTED/i);
    expect(sanitized.nested.filePath).toMatch(/\[REDACTED/i);
  });

  test("normalizeDependencyList keeps only valid dependency ids", () => {
    const deps = __testing.normalizeDependencyList([
      "feat-001",
      "",
      null,
      "   ",
      "feat-002",
    ]);
    expect(deps).toEqual(["feat-001", "feat-002"]);
  });

  test("schema migration is idempotent on repeated upgrades", async () => {
    const sqlite3 = sqlite3pkg.verbose();
    const db = await new Promise((resolve, reject) => {
      const instance = new sqlite3.Database(":memory:", (err) =>
        err ? reject(err) : resolve(instance),
      );
    });
    const run = (sql) =>
      new Promise((resolve, reject) =>
        db.run(sql, [], (err) => (err ? reject(err) : resolve())),
      );

    await run(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      feature_id TEXT,
      tool TEXT,
      status TEXT,
      model TEXT
    )`);
    await run(
      `CREATE TABLE features (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, priority INTEGER, created_at DATETIME)`,
    );
    await run(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)`);
    await run(`CREATE TABLE commits (id TEXT PRIMARY KEY)`);
    await run(
      `CREATE TABLE file_index (project_id TEXT, rel_path TEXT, fingerprint TEXT, PRIMARY KEY(project_id, rel_path))`,
    );
    await run(
      `CREATE TABLE audit_logs (id TEXT PRIMARY KEY, tool TEXT, phase TEXT, success INTEGER, payload TEXT)`,
    );

    await expect(__testing.ensureSchema(db)).resolves.toBeUndefined();
    await expect(__testing.ensureSchema(db)).resolves.toBeUndefined();

    await new Promise((resolve, reject) =>
      db.close((err) => (err ? reject(err) : resolve())),
    );
  });

  test("forge_template_load tolerates malformed template dependencies", async () => {
    const tools = new Map();
    const originalHome = process.env.HOME;
    const tempHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "forge-template-load-"),
    );
    process.env.HOME = tempHome;

    try {
      register({
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: (toolDef) => tools.set(toolDef.name, toolDef),
      });

      const templateDir = path.join(
        tempHome,
        ".openclaw-gateway",
        "forge-templates",
      );
      fs.mkdirSync(templateDir, { recursive: true });
      const templateFile = path.join(templateDir, "bad-deps.json");
      const template = {
        id: "bad-deps",
        name: "Bad Dependency Template",
        options: { language: "typescript" },
        features: [
          {
            name: "Feature A",
            description: "alpha",
            priority: 1,
            dependencies: { bad: "dep" },
          },
        ],
      };
      fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));

      const loadResult = await tools.get("forge_template_load").execute("t", {
        templateId: "bad-deps",
        projectName: "FromMalformedTemplate",
      });
      expect(loadResult.success).toBe(true);

      const status = await tools.get("forge_status").execute("t", {
        projectId: loadResult.projectId,
      });
      expect(status.success).toBe(true);
      expect(status.project.id).toBe(loadResult.projectId);
      expect(status.progress.total).toBe(1);
      expect(status.progress.pending).toBe(1);
    } finally {
      process.env.HOME = originalHome;
      await fs.promises.rm(tempHome, { recursive: true, force: true });
    }
  });
});
