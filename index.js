/**
 * Forge — 完整的 PRD → 代码自动化系统 v2.1
 *
 * 修复：
 * - P0: 真正的自动化调用（autoSpawn）
 * - P0: 并发安全（乐观锁）
 * - P1: 循环依赖检测
 * - P1: 依赖 ID 验证
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import sqlite3pkg from "sqlite3";

const sqlite3 = sqlite3pkg.verbose();
const DB_PATH = path.join(
  process.env.OPENCLAW_STATE_DIR || process.env.HOME || "/tmp",
  ".openclaw-gateway",
  "forge.db",
);
const PROJECTS_DIR = path.join(process.env.HOME || "/tmp", "forge-projects");

// 确保 DB 目录存在
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function initDB() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT,
          prd TEXT,
          architecture TEXT,
          status TEXT,
          github_url TEXT,
          workdir TEXT,
          options TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS features (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          name TEXT,
          description TEXT,
          priority INTEGER,
          status TEXT,
          dependencies TEXT,
          assigned_model TEXT,
          implementation TEXT,
          review_notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          feature_id TEXT,
          tool TEXT,
          status TEXT,
          model TEXT,
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          error TEXT,
          output TEXT
        )`);
        db.run(
          `CREATE TABLE IF NOT EXISTS commits (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          feature_id TEXT,
          sha TEXT,
          message TEXT,
          author TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
          [],
          () => resolve(db),
        );
      });
    });
  });
}

function closeDB(db) {
  try {
    db.close();
  } catch {}
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// 检测循环依赖（拓扑排序）
function detectCycle(features) {
  const graph = {};
  const visited = new Set();
  const recStack = new Set();

  features.forEach((f) => {
    graph[f.id] = JSON.parse(f.dependencies || "[]");
  });

  function dfs(node) {
    visited.add(node);
    recStack.add(node);

    for (const dep of graph[node] || []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recStack.has(dep)) {
        return true; // 发现环
      }
    }

    recStack.delete(node);
    return false;
  }

  for (const f of features) {
    if (!visited.has(f.id)) {
      if (dfs(f.id)) return true;
    }
  }

  return false;
}

// 验证依赖 ID 是否存在
function validateDependencies(features) {
  const ids = new Set(features.map((f) => f.id));
  const errors = [];

  features.forEach((f) => {
    const deps = JSON.parse(f.dependencies || "[]");
    deps.forEach((dep) => {
      if (!ids.has(dep)) {
        errors.push(`Feature "${f.id}" 依赖不存在的 "${dep}"`);
      }
    });
  });

  return errors;
}

function parsePRD(prdContent) {
  if (!prdContent || typeof prdContent !== "string") {
    return {
      name: "Untitled Project",
      overview: "",
      features: [],
      techStack: [],
    };
  }

  const lines = prdContent.split("\n");
  const project = {
    name: "Untitled Project",
    overview: "",
    features: [],
    techStack: [],
  };
  const seenIds = new Set();
  let currentFeature = null;
  let featureCounter = 0;
  let inOverview = false;
  let overviewLines = [];

  for (const line of lines) {
    if (line.startsWith("# ") && project.name === "Untitled Project") {
      project.name = line.replace(/^#\s*/, "").trim() || "Untitled Project";
      continue;
    }

    if (line.match(/^##\s*(概述|概览|Overview|Introduction)/i)) {
      inOverview = true;
      continue;
    }
    if (line.startsWith("## ") && inOverview) {
      inOverview = false;
    }
    if (inOverview && line.trim()) {
      overviewLines.push(line.trim());
    }

    if (
      line.match(/^(###|##)\s*Feature/i) ||
      line.match(/^(###|##)\s*(功能|Feature\s*\d+)/i)
    ) {
      if (currentFeature) {
        if (!seenIds.has(currentFeature.id)) {
          project.features.push(currentFeature);
          seenIds.add(currentFeature.id);
        }
      }
      featureCounter++;
      const match = line.match(/(?:###|##)\s*(?:Feature\s*)?(\d+)?:?\s*(.+)/i);
      const idx = match?.[1] || String(featureCounter);
      const name = (match?.[2] || `Feature ${idx}`).trim();
      currentFeature = {
        id: `feat-${String(idx).padStart(3, "0")}`,
        name,
        description: "",
        priority: 1,
        dependencies: [],
        implementation: "",
      };
      inOverview = false;
      continue;
    }

    if (currentFeature) {
      if (
        line.match(/^-?\s*\*\*描述\*\*[:-]?\s*/i) ||
        line.match(/^-?\s*描述[:-]?\s*/i)
      ) {
        currentFeature.description = line
          .replace(/^-?\s*(\*\*)?描述(\*\*)?[:-]?\s*/i, "")
          .trim();
      }
      if (
        line.match(/^-?\s*\*\*优先级\*\*[:-]?\s*/i) ||
        line.match(/^-?\s*优先级[:-]?\s*/i)
      ) {
        const p = line
          .replace(/^-?\s*(\*\*)?优先级(\*\*)?[:-]?\s*/i, "")
          .trim();
        currentFeature.priority =
          p === "P0" ? 0 : p === "P1" ? 1 : p === "P2" ? 2 : 1;
      }
      if (
        line.match(/^-?\s*\*\*依赖\*\*[:-]?\s*/i) ||
        line.match(/^-?\s*依赖[:-]?\s*/i)
      ) {
        const deps = line
          .replace(/^-?\s*(\*\*)?依赖(\*\*)?[:-]?\s*/i, "")
          .trim();
        currentFeature.dependencies =
          !deps || deps === "无" || deps === "None"
            ? []
            : deps
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean);
      }
    }

    if (line.match(/^-?\s*(技术栈|Tech Stack|技术选型)/i)) {
      const tech = line
        .replace(/^-?\s*(技术栈|Tech Stack|技术选型)[:-]?\s*/i, "")
        .trim();
      project.techStack = tech
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (currentFeature && !seenIds.has(currentFeature.id)) {
    project.features.push(currentFeature);
  }

  project.overview = overviewLines.join("\n").trim();
  return project;
}

function escapeShellArg(str) {
  if (!str) return "''";
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function tool(name, description, parameters, handler) {
  return {
    name,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      try {
        const p = params && typeof params === "object" ? params : {};
        return await handler(p);
      } catch (err) {
        return {
          success: false,
          error: err?.message || String(err),
          tool: name,
        };
      }
    },
  };
}

export default function register(api) {
  const logger = api.logger || console;

  // ==================== 工具 1: forge_init ====================
  api.registerTool(
    tool(
      "forge_init",
      "Initialize a new project from PRD",
      {
        type: "object",
        properties: {
          prd: { type: "string", description: "PRD content or file path" },
          options: {
            type: "object",
            properties: {
              architectModel: { type: "string" },
              coderModel: { type: "string" },
              reviewerModel: { type: "string" },
              maxParallel: { type: "number" },
              language: { type: "string" },
              framework: { type: "string" },
            },
          },
        },
        required: ["prd"],
      },
      async (params) => {
        const prd = params?.prd;
        const options = params?.options || {};

        if (!prd || typeof prd !== "string") {
          return { success: false, error: "Missing or invalid prd parameter" };
        }

        const db = await initDB();
        try {
          const projectId = `proj-${Date.now()}`;
          const prdContent = fs.existsSync(prd)
            ? fs.readFileSync(prd, "utf8")
            : prd;
          const parsed = parsePRD(prdContent);

          // P1: 验证依赖
          const depErrors = validateDependencies(parsed.features);
          if (depErrors.length > 0) {
            return {
              success: false,
              error: "Dependency validation failed",
              details: depErrors,
            };
          }

          // P1: 检测循环依赖
          if (detectCycle(parsed.features)) {
            return {
              success: false,
              error: "Circular dependency detected in features",
            };
          }

          const workdir = path.join(PROJECTS_DIR, projectId);
          fs.mkdirSync(workdir, { recursive: true });
          fs.writeFileSync(path.join(workdir, "PRD.md"), prdContent);

          const defaultOptions = {
            architectModel:
              options.architectModel ||
              "anthropic-newcli/claude-opus-4-6-20250528",
            coderModel:
              options.coderModel || "anthropic-newcli/claude-opus-4-6-20250528",
            reviewerModel:
              options.reviewerModel ||
              "anthropic-newcli/claude-opus-4-6-20250528",
            maxParallel: options.maxParallel || 3,
            language: options.language || "typescript",
            framework: options.framework || "auto",
          };

          await run(
            db,
            `INSERT INTO projects (id, name, prd, status, workdir, options) VALUES (?,?,?,?,?,?)`,
            [
              projectId,
              parsed.name,
              prdContent,
              "initialized",
              workdir,
              JSON.stringify(defaultOptions),
            ],
          );

          for (const f of parsed.features) {
            await run(
              db,
              `INSERT INTO features (id, project_id, name, description, priority, status, dependencies) VALUES (?,?,?,?,?,?,?)`,
              [
                f.id,
                projectId,
                f.name,
                f.description,
                f.priority,
                "pending",
                JSON.stringify(f.dependencies),
              ],
            );
          }

          logger.info?.(
            `[forge] Project initialized: ${projectId} with ${parsed.features.length} features`,
          );

          return {
            success: true,
            projectId,
            projectName: parsed.name,
            featureCount: parsed.features.length,
            workdir,
            options: defaultOptions,
            overview: parsed.overview,
            techStack: parsed.techStack,
            nextStep: "Run forge_plan to design the architecture",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 2: forge_plan ====================
  api.registerTool(
    tool(
      "forge_plan",
      "Design architecture for the project using AI",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          additionalContext: { type: "string" },
          autoSpawn: {
            type: "boolean",
            description: "Automatically spawn architect agent (default: true)",
          },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const additionalContext = params?.additionalContext || "";
        const shouldAutoSpawn = params?.autoSpawn !== false;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const features = await all(
            db,
            "SELECT id, name, description, dependencies FROM features WHERE project_id=?",
            [projectId],
          );
          const options = JSON.parse(project.options || "{}");

          const archPrompt = `# Architecture Design Task

## Project: ${project.name}

## PRD Overview
${project.prd?.substring(0, 3000) || "No PRD"}

## Features to Implement
${features.map((f) => `- **${f.id}**: ${f.name} - ${f.description}`).join("\n")}

## Requirements
1. Design a clean, modular architecture
2. Identify core components and their responsibilities
3. Define data models and interfaces
4. Suggest directory structure
5. List key dependencies

${additionalContext ? `## Additional Context\n${additionalContext}` : ""}

## Output Format
Provide:
1. Architecture Overview (2-3 sentences)
2. Core Components (list with responsibilities)
3. Directory Structure (tree format)
4. Data Models (if applicable)
5. Key Dependencies

After designing, save the result by calling forge_save_architecture with the architecture content.`;

          await run(db, "UPDATE projects SET status=? WHERE id=?", [
            "planning",
            projectId,
          ]);

          // 记录 run
          const runId = `run-${Date.now()}`;
          await run(
            db,
            "INSERT INTO runs (id, project_id, tool, status, model) VALUES (?,?,?,?,?)",
            [runId, projectId, "forge_plan", "running", options.architectModel],
          );

          logger.info?.(
            `[forge] Architecture planning started for ${projectId}`,
          );

          // P0: 真正自动化 - 返回 autoSpawn 指令
          if (shouldAutoSpawn) {
            return {
              success: true,
              projectId,
              status: "planning",
              autoSpawn: {
                tool: "sessions_spawn",
                params: {
                  agentId: "architect",
                  model:
                    options.architectModel ||
                    "anthropic-newcli/claude-opus-4-6-20250528",
                  task: archPrompt,
                  timeoutSeconds: 600,
                },
                onComplete: {
                  tool: "forge_save_architecture",
                  params: { projectId },
                  resultField: "architecture",
                },
              },
              architecturePrompt: archPrompt,
              suggestedModel: options.architectModel,
              runId,
              instruction:
                "Auto-spawning architect agent. Result will be saved via forge_save_architecture.",
            };
          }

          return {
            success: true,
            projectId,
            projectName: project.name,
            workdir: project.workdir,
            status: "planning",
            architecturePrompt: archPrompt,
            suggestedModel: options.architectModel,
            features: features.length,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 3: forge_save_architecture ====================
  api.registerTool(
    tool(
      "forge_save_architecture",
      "Save architecture design to project",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          architecture: { type: "string" },
        },
        required: ["projectId", "architecture"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const architecture = params?.architecture;

        if (!projectId || !architecture) {
          return { success: false, error: "Missing projectId or architecture" };
        }

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project) return { success: false, error: "Project not found" };

          await run(
            db,
            "UPDATE projects SET architecture=?, status=? WHERE id=?",
            [architecture, "planned", projectId],
          );

          const archFile = path.join(project.workdir, "ARCHITECTURE.md");
          fs.writeFileSync(archFile, architecture);

          logger.info?.(`[forge] Architecture saved for ${projectId}`);

          return {
            success: true,
            projectId,
            status: "planned",
            architectureFile: archFile,
            nextStep: "Run forge_next to get the first feature to implement",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 4: forge_next ====================
  api.registerTool(
    tool(
      "forge_next",
      "Get next feature to implement (dependency-aware)",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          count: { type: "number" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const count = Math.max(1, params?.count || 1);

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const features = await all(
            db,
            "SELECT * FROM features WHERE project_id=? AND status=? ORDER BY priority ASC, created_at ASC",
            [projectId, "pending"],
          );

          const completeIds = new Set(
            (
              await all(
                db,
                "SELECT id FROM features WHERE project_id=? AND status=?",
                [projectId, "complete"],
              )
            ).map((f) => f.id),
          );

          const pendingIds = new Set(features.map((f) => f.id));

          const ready = features
            .filter((f) => {
              const deps = JSON.parse(f.dependencies || "[]");
              return deps.every(
                (d) => completeIds.has(d) || !pendingIds.has(d),
              );
            })
            .slice(0, count);

          logger.info?.(
            `[forge] Found ${ready.length} ready features for ${projectId}`,
          );

          return {
            success: true,
            projectId,
            readyFeatures: ready,
            pendingCount: features.length,
            readyCount: ready.length,
            inProgressCount: (
              await all(
                db,
                "SELECT id FROM features WHERE project_id=? AND status=?",
                [projectId, "in_progress"],
              )
            ).length,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 5: forge_claim ====================
  api.registerTool(
    tool(
      "forge_claim",
      "Claim a feature for implementation (concurrent-safe)",
      {
        type: "object",
        properties: {
          featureId: { type: "string" },
          model: { type: "string" },
        },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        const model =
          params?.model || "anthropic-newcli/claude-opus-4-6-20250528";

        if (!featureId) return { success: false, error: "Missing featureId" };

        const db = await initDB();
        try {
          // P0: 乐观锁 - 只在状态为 pending 时更新
          const result = await run(
            db,
            "UPDATE features SET status=?, assigned_model=? WHERE id=? AND status=?",
            ["in_progress", model, featureId, "pending"],
          );

          if (result.changes === 0) {
            // 检查是已完成还是被其他人认领
            const existing = await get(
              db,
              "SELECT status, assigned_model FROM features WHERE id=?",
              [featureId],
            );
            if (!existing) {
              return { success: false, error: "Feature not found", featureId };
            }
            if (existing.status === "complete") {
              return {
                success: false,
                error: "Feature already complete",
                featureId,
              };
            }
            return {
              success: false,
              error: "Feature already claimed by another agent",
              featureId,
              currentStatus: existing.status,
              assignedModel: existing.assigned_model,
            };
          }

          const existing = await get(
            db,
            "SELECT f.*, p.name as project_name, p.workdir, p.architecture, p.options FROM features f JOIN projects p ON f.project_id = p.id WHERE f.id=?",
            [featureId],
          );
          const options = JSON.parse(existing.options || "{}");

          const implPrompt = `# Implementation Task

## Feature: ${existing.name}
**ID**: ${existing.id}
**Description**: ${existing.description}

## Project Context
- **Project**: ${existing.project_name}
- **Work Directory**: ${existing.workdir}

## Architecture
${existing.architecture || "No architecture defined yet"}

## Requirements
1. Implement the feature following the project architecture
2. Write clean, well-documented code
3. Include error handling
4. Add unit tests if applicable

## Output
Provide the complete implementation including:
1. File paths and their contents
2. Any new dependencies needed
3. Test cases`;

          logger.info?.(`[forge] Feature ${featureId} claimed by ${model}`);

          return {
            success: true,
            featureId,
            projectId: existing.project_id,
            status: "in_progress",
            model,
            workdir: existing.workdir,
            implementationPrompt: implPrompt,
            suggestedModel: model,
            language: options.language || "typescript",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 6: forge_implement ====================
  api.registerTool(
    tool(
      "forge_implement",
      "Automatically implement a feature by spawning a coding agent",
      {
        type: "object",
        properties: {
          featureId: { type: "string" },
          model: { type: "string" },
          timeoutSeconds: { type: "number" },
          autoSpawn: {
            type: "boolean",
            description: "Automatically spawn coding agent (default: true)",
          },
          maxRetries: {
            type: "number",
            description: "Max auto-retry attempts on failure (default: 2, P4)",
          },
        },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        const model = params?.model;
        const timeoutSeconds = params?.timeoutSeconds || 600;
        const shouldAutoSpawn = params?.autoSpawn !== false;
        const maxRetries = params?.maxRetries ?? 2; // P4: auto-retry

        if (!featureId) return { success: false, error: "Missing featureId" };

        const db = await initDB();
        try {
          const feature = await get(
            db,
            `SELECT f.*, p.name as project_name, p.workdir, p.architecture, p.options
        FROM features f JOIN projects p ON f.project_id = p.id WHERE f.id=?`,
            [featureId],
          );

          if (!feature)
            return { success: false, error: "Feature not found", featureId };

          // P0: 乐观锁 - 只在 pending 状态时更新
          if (feature.status === "pending") {
            const result = await run(
              db,
              "UPDATE features SET status=?, assigned_model=? WHERE id=? AND status=?",
              ["in_progress", model || "auto", featureId, "pending"],
            );
            if (result.changes === 0) {
              return {
                success: false,
                error: "Feature was claimed by another agent",
                featureId,
              };
            }
          } else if (feature.status === "complete") {
            return {
              success: false,
              error: "Feature already complete",
              featureId,
            };
          }
          // in_progress 状态继续执行

          const options = JSON.parse(feature.options || "{}");
          const useModel =
            model ||
            options.coderModel ||
            "anthropic-newcli/claude-opus-4-6-20250528";

          const taskPrompt = `# Implementation Task

## Project: ${feature.project_name}
## Feature: ${feature.name}

**Description**: ${feature.description}
**Dependencies**: ${JSON.parse(feature.dependencies || "[]").join(", ") || "None"}

## Work Directory
${feature.workdir}

## Architecture
${feature.architecture || "No architecture defined"}

## Task
1. Create necessary files in the work directory
2. Implement the feature following best practices
3. Include error handling
4. Add appropriate comments

## Output Format
After implementation:
1. List all files created/modified
2. Summarize key implementation decisions
3. Report any issues encountered
4. Call forge_done to mark completion`;

          // 记录 run
          const runId = `run-${Date.now()}`;
          await run(
            db,
            "INSERT INTO runs (id, project_id, feature_id, tool, status, model) VALUES (?,?,?,?,?,?)",
            [
              runId,
              feature.project_id,
              featureId,
              "forge_implement",
              "running",
              useModel,
            ],
          );

          logger.info?.(
            `[forge] Implementing ${featureId} with model ${useModel}`,
          );

          // P4: workdir 删除检测
          if (!fs.existsSync(feature.workdir)) {
            fs.mkdirSync(feature.workdir, { recursive: true });
          }

          // P0: 真正自动化
          if (shouldAutoSpawn) {
            return {
              success: true,
              featureId,
              projectId: feature.project_id,
              status: "spawning",
              model: useModel,
              workdir: feature.workdir,
              autoSpawn: {
                tool: "sessions_spawn",
                params: {
                  agentId: "coder",
                  model: useModel,
                  task: taskPrompt,
                  timeoutSeconds,
                },
                onComplete: {
                  tool: "forge_done",
                  params: { featureId },
                  resultField: "implementation",
                },
                onError:
                  maxRetries > 0
                    ? {
                        tool: "forge_retry",
                        params: { featureId, model: useModel },
                        maxRetries,
                      }
                    : null,
              },
              task: taskPrompt,
              runId,
              maxRetries,
              instruction:
                "Auto-spawning coding agent. Result will be saved via forge_done.",
            };
          }

          return {
            success: true,
            featureId,
            projectId: feature.project_id,
            status: "ready",
            model: useModel,
            workdir: feature.workdir,
            task: taskPrompt,
            timeoutSeconds,
            instruction: `Use sessions_spawn with agentId="coder", model="${useModel}", and task above.`,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 7: forge_done ====================
  api.registerTool(
    tool(
      "forge_done",
      "Mark a feature as complete with implementation notes",
      {
        type: "object",
        properties: {
          featureId: { type: "string" },
          implementation: { type: "string" },
        },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        const implementation = params?.implementation || "";

        if (!featureId) return { success: false, error: "Missing featureId" };

        const db = await initDB();
        try {
          const existing = await get(
            db,
            "SELECT f.*, p.id as project_id FROM features f JOIN projects p ON f.project_id = p.id WHERE f.id=?",
            [featureId],
          );
          if (!existing)
            return { success: false, error: "Feature not found", featureId };

          const wasComplete = existing.status === "complete";
          await run(
            db,
            "UPDATE features SET status=?, implementation=? WHERE id=?",
            ["complete", implementation, featureId],
          );

          // 更新 run 状态
          await run(
            db,
            "UPDATE runs SET status=?, completed_at=? WHERE feature_id=? AND status=?",
            ["success", new Date().toISOString(), featureId, "running"],
          );

          const remaining = await all(
            db,
            "SELECT id FROM features WHERE project_id=? AND status!=?",
            [existing.project_id, "complete"],
          );

          logger.info?.(`[forge] Feature ${featureId} marked complete`);

          return {
            success: true,
            featureId,
            projectId: existing.project_id,
            status: "complete",
            implementation,
            wasAlreadyComplete: wasComplete,
            remainingFeatures: remaining.length,
            allComplete: remaining.length === 0,
            nextStep:
              remaining.length > 0
                ? "Run forge_next to get next feature"
                : "All features complete! Run forge_review or forge_push",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 8: forge_status ====================
  api.registerTool(
    tool(
      "forge_status",
      "View project progress and details",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          detailed: { type: "boolean" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const detailed = params?.detailed || false;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const counts = await all(
            db,
            "SELECT status, COUNT(*) as count FROM features WHERE project_id=? GROUP BY status",
            [projectId],
          );
          const allFeatures = detailed
            ? await all(
                db,
                "SELECT id, name, status, priority, assigned_model FROM features WHERE project_id=? ORDER BY priority, created_at",
                [projectId],
              )
            : null;

          const runs = await all(
            db,
            "SELECT id, feature_id, tool, status, model, started_at, completed_at FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 10",
            [projectId],
          );

          const statusMap = {};
          counts.forEach((c) => (statusMap[c.status] = c.count));
          const total = Object.values(statusMap).reduce((a, b) => a + b, 0);

          return {
            success: true,
            project: {
              id: project.id,
              name: project.name,
              status: project.status,
              workdir: project.workdir,
              github_url: project.github_url,
              architecture: project.architecture ? "defined" : "not defined",
              createdAt: project.created_at,
            },
            progress: {
              total,
              pending: statusMap["pending"] || 0,
              inProgress: statusMap["in_progress"] || 0,
              complete: statusMap["complete"] || 0,
              percentage:
                total > 0
                  ? Math.round(((statusMap["complete"] || 0) / total) * 100)
                  : 0,
            },
            featureCounts: counts,
            features: allFeatures,
            recentRuns: runs,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 9: forge_review ====================
  api.registerTool(
    tool(
      "forge_review",
      "Review completed features with AI",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          featureId: { type: "string" },
          model: { type: "string" },
          autoSpawn: {
            type: "boolean",
            description: "Automatically spawn review agent (default: true)",
          },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const featureId = params?.featureId || null;
        const model = params?.model;
        const shouldAutoSpawn = params?.autoSpawn !== false;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          let features;
          if (featureId) {
            features = await all(
              db,
              "SELECT * FROM features WHERE project_id=? AND id=?",
              [projectId, featureId],
            );
          } else {
            features = await all(
              db,
              "SELECT * FROM features WHERE project_id=? AND status=?",
              [projectId, "complete"],
            );
          }

          const options = JSON.parse(project.options || "{}");
          const reviewModel =
            model ||
            options.reviewerModel ||
            "anthropic-newcli/claude-opus-4-6-20250528";

          const reviewPrompt = `# Code Review Task

## Project: ${project.name}
## Work Directory: ${project.workdir}

## Features to Review
${features
  .map(
    (f) => `### ${f.id}: ${f.name}
**Description**: ${f.description}
**Implementation Notes**: ${f.implementation || "None"}
`,
  )
  .join("\n")}

## Review Checklist
1. Code quality and readability
2. Error handling
3. Security concerns
4. Performance considerations
5. Test coverage
6. Documentation

## Output Format
For each feature:
- Status: PASS / NEEDS_REVISION
- Issues found (if any)
- Suggestions for improvement`;

          logger.info?.(
            `[forge] Review requested for ${features.length} features in ${projectId}`,
          );

          if (shouldAutoSpawn && features.length > 0) {
            return {
              success: true,
              projectId,
              workdir: project.workdir,
              featuresToReview: features.length,
              autoSpawn: {
                tool: "sessions_spawn",
                params: {
                  agentId: "reviewer",
                  model: reviewModel,
                  task: reviewPrompt,
                  timeoutSeconds: 300,
                },
              },
              reviewPrompt,
              suggestedModel: reviewModel,
            };
          }

          return {
            success: true,
            projectId,
            projectName: project.name,
            workdir: project.workdir,
            featuresToReview: features.length,
            features,
            reviewPrompt,
            suggestedModel: reviewModel,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 10: forge_test ====================
  api.registerTool(
    tool(
      "forge_test",
      "Run tests for the project",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          featureId: { type: "string" },
          testCommand: { type: "string" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const featureId = params?.featureId;
        const testCommand = params?.testCommand;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          if (!fs.existsSync(project.workdir)) {
            return {
              success: false,
              error: "Project workdir does not exist",
              workdir: project.workdir,
            };
          }

          const options = JSON.parse(project.options || "{}");
          const language = options.language || "typescript";

          // P4: 环境检测
          let envReady = true;
          let envError = null;
          if (language === "typescript" || language === "javascript") {
            if (!fs.existsSync(path.join(project.workdir, "package.json"))) {
              envReady = false;
              envError =
                "package.json not found - run forge_init_project first";
            }
          } else if (language === "go") {
            if (!fs.existsSync(path.join(project.workdir, "go.mod"))) {
              envReady = false;
              envError = "go.mod not found - run forge_init_project first";
            }
          } else if (language === "rust") {
            if (!fs.existsSync(path.join(project.workdir, "Cargo.toml"))) {
              envReady = false;
              envError = "Cargo.toml not found - run forge_init_project first";
            }
          }

          if (!envReady) {
            return {
              success: false,
              error: "Test environment not ready",
              envError,
              workdir: project.workdir,
            };
          }

          let cmd = testCommand;
          if (!cmd) {
            const testCommands = {
              typescript: "npm test 2>&1 || yarn test 2>&1",
              javascript: "npm test 2>&1",
              python: "pytest 2>&1 || python -m pytest 2>&1",
              go: "go test ./... 2>&1",
              rust: "cargo test 2>&1",
            };
            cmd = testCommands[language] || "npm test 2>&1";
          }

          let output = "";
          let success = false;
          try {
            output = execSync(cmd, {
              cwd: project.workdir,
              encoding: "utf8",
              timeout: 120000,
            });
            success = true;
          } catch (err) {
            output = err.stdout || err.stderr || err.message;
          }

          logger.info?.(
            `[forge] Tests run for ${projectId}: ${success ? "PASS" : "FAIL"}`,
          );

          return {
            success: true,
            projectId,
            workdir: project.workdir,
            testCommand: cmd,
            testPassed: success,
            output: output.substring(0, 5000),
            featureId,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 11: forge_push ====================
  api.registerTool(
    tool(
      "forge_push",
      "Push project to GitHub",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          repoName: { type: "string" },
          visibility: { type: "string", enum: ["public", "private"] },
          commitMessage: { type: "string" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        let repoName = params?.repoName;
        const visibility = params?.visibility || "private";
        const commitMessage =
          params?.commitMessage || "Implement features via Forge";

        if (!projectId) return { success: false, error: "Missing projectId" };

        try {
          execSync("gh --version", { stdio: "ignore" });
        } catch {
          return {
            success: false,
            error: "GitHub CLI (gh) not installed. Run: brew install gh",
          };
        }

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const workdir = project.workdir;
          if (!fs.existsSync(workdir)) {
            return {
              success: false,
              error: "Project workdir does not exist",
              workdir,
            };
          }

          if (!repoName) {
            repoName = project.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
          }

          if (!fs.existsSync(path.join(workdir, ".git"))) {
            execSync("git init", { cwd: workdir });
            execSync("git add -A", { cwd: workdir });
            execSync(
              `git commit -m "${escapeShellArg(commitMessage).slice(1, -1)}"`,
              { cwd: workdir },
            );
          }

          const visibilityFlag =
            visibility === "public" ? "--public" : "--private";
          const safeRepoName = escapeShellArg(repoName);

          let githubUrl = "";
          try {
            const result = execSync(
              `gh repo create ${safeRepoName} ${visibilityFlag} --source="${workdir}" --push --description="${escapeShellArg(project.name)}" 2>&1`,
              { cwd: workdir, encoding: "utf8" },
            );
            const match = result.match(/https:\/\/github\.com\/[^\s]+/);
            githubUrl = match ? match[0] : `https://github.com/${safeRepoName}`;
          } catch (err) {
            if (err.message?.includes("already exists")) {
              const ghUser = execSync(
                'gh api user --jq .login 2>/dev/null || echo "unknown"',
                { encoding: "utf8" },
              ).trim();
              execSync(
                `git remote add origin https://github.com/${ghUser}/${safeRepoName}.git 2>/dev/null || git remote set-url origin https://github.com/${ghUser}/${safeRepoName}.git`,
                { cwd: workdir },
              );
              execSync("git push -u origin HEAD 2>&1", { cwd: workdir });
              githubUrl = `https://github.com/${ghUser}/${repoName}`;
            } else {
              throw err;
            }
          }

          await run(
            db,
            "UPDATE projects SET github_url=?, status=? WHERE id=?",
            [githubUrl, "pushed", projectId],
          );

          logger.info?.(`[forge] Project ${projectId} pushed to ${githubUrl}`);

          return {
            success: true,
            projectId,
            githubUrl,
            repoName,
            visibility,
            workdir,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 12: forge_run ====================
  api.registerTool(
    tool(
      "forge_run",
      "Run full automation pipeline",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const steps = params?.steps || [
          "plan",
          "implement",
          "review",
          "test",
          "push",
        ];

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const features = await all(
            db,
            "SELECT id, name, status FROM features WHERE project_id=?",
            [projectId],
          );
          const options = JSON.parse(project.options || "{}");

          const workflow = [];
          if (steps.includes("plan")) {
            workflow.push({
              step: "plan",
              tool: "forge_plan",
              description: "Design architecture",
              model: options.architectModel,
              autoSpawn: true,
            });
          }
          if (steps.includes("implement")) {
            workflow.push({
              step: "implement",
              tool: "forge_next + forge_implement",
              description: `Implement ${features.length} features`,
              model: options.coderModel,
              parallel: options.maxParallel,
              autoSpawn: true,
            });
          }
          if (steps.includes("review")) {
            workflow.push({
              step: "review",
              tool: "forge_review",
              description: "Code review",
              model: options.reviewerModel,
              autoSpawn: true,
            });
          }
          if (steps.includes("test")) {
            workflow.push({
              step: "test",
              tool: "forge_test",
              description: "Run tests",
            });
          }
          if (steps.includes("push")) {
            workflow.push({
              step: "push",
              tool: "forge_push",
              description: "Push to GitHub",
            });
          }

          return {
            success: true,
            projectId,
            projectName: project.name,
            status: project.status,
            features: features.length,
            workflow,
            instruction:
              "Each step with autoSpawn=true will automatically spawn the required agent. Execute steps in order.",
            maxParallel: options.maxParallel || 3,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 13: forge_retry ====================
  api.registerTool(
    tool(
      "forge_retry",
      "Retry a failed feature implementation",
      {
        type: "object",
        properties: {
          featureId: { type: "string" },
          model: { type: "string" },
          timeoutSeconds: { type: "number" },
        },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        const model = params?.model;
        const timeoutSeconds = params?.timeoutSeconds || 600;

        if (!featureId) return { success: false, error: "Missing featureId" };

        const db = await initDB();
        try {
          const feature = await get(
            db,
            `SELECT f.*, p.name as project_name, p.workdir, p.architecture, p.options
        FROM features f JOIN projects p ON f.project_id = p.id WHERE f.id=?`,
            [featureId],
          );

          if (!feature)
            return { success: false, error: "Feature not found", featureId };

          // 重置状态为 pending，然后重新实现
          await run(
            db,
            "UPDATE features SET status=?, implementation=?, assigned_model=? WHERE id=?",
            ["pending", "", null, featureId],
          );

          // 更新 run 状态
          await run(
            db,
            "UPDATE runs SET status=? WHERE feature_id=? AND status=?",
            ["retrying", featureId, "running"],
          );

          const options = JSON.parse(feature.options || "{}");
          const useModel =
            model ||
            options.coderModel ||
            "anthropic-newcli/claude-opus-4-6-20250528";

          logger.info?.(`[forge] Retrying ${featureId} with model ${useModel}`);

          // 调用 forge_implement 的逻辑
          const taskPrompt = `# Implementation Task (Retry)

## Project: ${feature.project_name}
## Feature: ${feature.name}

**Description**: ${feature.description}
**Note**: This is a retry attempt.

## Work Directory
${feature.workdir}

## Architecture
${feature.architecture || "No architecture defined"}

## Task
1. Create necessary files in the work directory
2. Implement the feature following best practices
3. Include error handling
4. Add appropriate comments`;

          const runId = `run-${Date.now()}`;
          await run(
            db,
            "INSERT INTO runs (id, project_id, feature_id, tool, status, model) VALUES (?,?,?,?,?,?)",
            [
              runId,
              feature.project_id,
              featureId,
              "forge_retry",
              "running",
              useModel,
            ],
          );

          return {
            success: true,
            featureId,
            projectId: feature.project_id,
            status: "retrying",
            model: useModel,
            autoSpawn: {
              tool: "sessions_spawn",
              params: {
                agentId: "coder",
                model: useModel,
                task: taskPrompt,
                timeoutSeconds,
              },
              onComplete: {
                tool: "forge_done",
                params: { featureId },
                resultField: "implementation",
              },
            },
            task: taskPrompt,
            runId,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 14: forge_cancel ====================
  api.registerTool(
    tool(
      "forge_cancel",
      "Cancel an in-progress feature",
      {
        type: "object",
        properties: {
          featureId: { type: "string" },
          reason: { type: "string", description: "Cancellation reason" },
        },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        const reason = params?.reason || "User cancelled";

        if (!featureId) return { success: false, error: "Missing featureId" };

        const db = await initDB();
        try {
          const feature = await get(db, "SELECT * FROM features WHERE id=?", [
            featureId,
          ]);
          if (!feature)
            return { success: false, error: "Feature not found", featureId };

          if (feature.status !== "in_progress") {
            return {
              success: false,
              error: `Feature is not in progress (status: ${feature.status})`,
              featureId,
            };
          }

          await run(
            db,
            "UPDATE features SET status=?, implementation=? WHERE id=?",
            ["cancelled", `Cancelled: ${reason}`, featureId],
          );

          await run(
            db,
            "UPDATE runs SET status=?, error=? WHERE feature_id=? AND status=?",
            ["cancelled", reason, featureId, "running"],
          );

          logger.info?.(`[forge] Feature ${featureId} cancelled: ${reason}`);

          return {
            success: true,
            featureId,
            projectId: feature.project_id,
            status: "cancelled",
            reason,
            nextStep:
              "Run forge_next to get next feature or forge_retry to retry this one",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 15: forge_init_project ====================
  api.registerTool(
    tool(
      "forge_init_project",
      "Initialize project structure (package.json, tsconfig, etc.)",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          language: {
            type: "string",
            description: "typescript, javascript, python, go, rust",
          },
          framework: {
            type: "string",
            description: "react, nextjs, express, fastapi, etc.",
          },
          name: {
            type: "string",
            description: "Project name (default: from PRD)",
          },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const language = params?.language;
        const framework = params?.framework;
        const name = params?.name;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const workdir = project.workdir;
          if (!fs.existsSync(workdir)) {
            fs.mkdirSync(workdir, { recursive: true });
          }

          const options = JSON.parse(project.options || "{}");
          const lang = language || options.language || "typescript";
          const projName =
            name || project.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

          const files = {};

          // 根据语言生成基础文件
          if (lang === "typescript" || lang === "javascript") {
            const pkgJson = {
              name: projName,
              version: "0.1.0",
              description: project.name,
              main: lang === "typescript" ? "dist/index.js" : "index.js",
              scripts: {
                start:
                  lang === "typescript"
                    ? "node dist/index.js"
                    : "node index.js",
                build: lang === "typescript" ? "tsc" : 'echo "No build needed"',
                test: "jest",
                lint: "eslint src/",
              },
              dependencies: {},
              devDependencies:
                lang === "typescript"
                  ? {
                      typescript: "^5.0.0",
                      "@types/node": "^20.0.0",
                      jest: "^29.0.0",
                      "@types/jest": "^29.0.0",
                    }
                  : {
                      jest: "^29.0.0",
                    },
            };

            // 根据框架添加依赖
            if (framework === "react" || framework === "nextjs") {
              pkgJson.dependencies.react = "^18.0.0";
              pkgJson.dependencies["react-dom"] = "^18.0.0";
              if (framework === "nextjs") {
                pkgJson.dependencies.next = "^14.0.0";
                pkgJson.scripts.dev = "next dev";
                pkgJson.scripts.build = "next build";
              }
            } else if (framework === "express") {
              pkgJson.dependencies.express = "^4.18.0";
            }

            files["package.json"] = JSON.stringify(pkgJson, null, 2);

            if (lang === "typescript") {
              const tsconfig = {
                compilerOptions: {
                  target: "ES2022",
                  module: "NodeNext",
                  moduleResolution: "NodeNext",
                  outDir: "./dist",
                  rootDir: "./src",
                  strict: true,
                  esModuleInterop: true,
                  skipLibCheck: true,
                },
                include: ["src/**/*"],
                exclude: ["node_modules", "dist"],
              };
              files["tsconfig.json"] = JSON.stringify(tsconfig, null, 2);
            }

            // .gitignore
            files[".gitignore"] = `node_modules/
dist/
.env
*.log
.DS_Store
`;

            // README
            files["README.md"] = `# ${project.name}

## Setup

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## Development

\`\`\`bash
npm run dev
\`\`\`

## Test

\`\`\`bash
npm test
\`\`\`
`;

            // src 目录
            const indexFile =
              lang === "typescript" ? "src/index.ts" : "src/index.js";
            files[indexFile] =
              lang === "typescript"
                ? `export function main() {
  console.log('Hello from ${project.name}!');
}

main();
`
                : `function main() {
  console.log('Hello from ${project.name}!');
}

main();
`;
          } else if (lang === "python") {
            files["pyproject.toml"] = `[project]
name = "${projName}"
version = "0.1.0"
description = "${project.name}"
requires-python = ">=3.10"

[project.optional-dependencies]
dev = ["pytest", "black", "ruff"]
`;
            files["requirements.txt"] =
              framework === "fastapi" ? "fastapi\nuvicorn\n" : "";
            files[".gitignore"] = `__pycache__/
*.pyc
.env
.venv/
*.egg-info/
`;
            files["src/__init__.py"] = "";
            files["main.py"] =
              framework === "fastapi"
                ? `from fastapi import FastAPI

app = FastAPI(title="${project.name}")

@app.get("/")
def root():
    return {"message": "Hello from ${project.name}"}
`
                : `def main():
    print("Hello from ${project.name}!")

if __name__ == "__main__":
    main()
`;
          } else if (lang === "go") {
            const goMod = `module ${projName}

go 1.21
`;
            files["go.mod"] = goMod;
            files["main.go"] = `package main

import "fmt"

func main() {
    fmt.Println("Hello from ${project.name}!")
}
`;
            files[".gitignore"] = `${projName}
*.exe
*.exe~
*.dll
*.so
*.dylib
`;
          } else if (lang === "rust") {
            files["Cargo.toml"] = `[package]
name = "${projName}"
version = "0.1.0"
edition = "2021"

[dependencies]
`;
            files["src/main.rs"] = `fn main() {
    println!("Hello from ${project.name}!");
}
`;
            files[".gitignore"] = `target/
Cargo.lock
`;
          }

          // 写入文件
          const createdFiles = [];
          for (const [filename, content] of Object.entries(files)) {
            const filepath = path.join(workdir, filename);
            const dir = path.dirname(filepath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filepath, content);
            createdFiles.push(filename);
          }

          // 更新项目选项
          options.language = lang;
          options.framework = framework || "none";
          await run(db, "UPDATE projects SET options=? WHERE id=?", [
            JSON.stringify(options),
            projectId,
          ]);

          logger.info?.(
            `[forge] Project initialized for ${projectId}: ${createdFiles.length} files`,
          );

          return {
            success: true,
            projectId,
            workdir,
            language: lang,
            framework: framework || "none",
            createdFiles,
            nextStep: "Run forge_install to install dependencies",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 16: forge_install ====================
  api.registerTool(
    tool(
      "forge_install",
      "Install project dependencies",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          packages: {
            type: "array",
            items: { type: "string" },
            description: "Additional packages to install",
          },
          dev: { type: "boolean", description: "Install as dev dependencies" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const packages = params?.packages || [];
        const dev = params?.dev || false;

        if (!projectId) return { success: false, error: "Missing projectId" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const workdir = project.workdir;
          if (!fs.existsSync(workdir)) {
            return {
              success: false,
              error: "Project workdir does not exist",
              workdir,
            };
          }

          const options = JSON.parse(project.options || "{}");
          const language = options.language || "typescript";

          let cmd = "";
          let output = "";

          if (language === "typescript" || language === "javascript") {
            if (fs.existsSync(path.join(workdir, "yarn.lock"))) {
              cmd = "yarn install";
              if (packages.length > 0) {
                cmd += dev
                  ? ` && yarn add -D ${packages.join(" ")}`
                  : ` && yarn add ${packages.join(" ")}`;
              }
            } else {
              cmd = "npm install";
              if (packages.length > 0) {
                cmd += dev
                  ? ` && npm install -D ${packages.join(" ")}`
                  : ` && npm install ${packages.join(" ")}`;
              }
            }
          } else if (language === "python") {
            if (fs.existsSync(path.join(workdir, "pyproject.toml"))) {
              cmd = "pip install -e .";
            } else if (fs.existsSync(path.join(workdir, "requirements.txt"))) {
              cmd = "pip install -r requirements.txt";
            }
            if (packages.length > 0) {
              cmd += ` && pip install ${packages.join(" ")}`;
            }
          } else if (language === "go") {
            cmd = "go mod tidy";
            if (packages.length > 0) {
              cmd += ` && go get ${packages.join(" ")}`;
            }
          } else if (language === "rust") {
            cmd = "cargo fetch";
            if (packages.length > 0) {
              for (const pkg of packages) {
                cmd += ` && cargo add ${pkg}`;
              }
            }
          } else {
            return {
              success: false,
              error: `Unsupported language: ${language}`,
            };
          }

          try {
            output = execSync(cmd, {
              cwd: workdir,
              encoding: "utf8",
              timeout: 300000,
            });
          } catch (err) {
            return {
              success: false,
              error: "Installation failed",
              output: err.stdout || err.stderr || err.message,
              workdir,
            };
          }

          logger.info?.(`[forge] Dependencies installed for ${projectId}`);

          return {
            success: true,
            projectId,
            workdir,
            command: cmd,
            packages: packages.length > 0 ? packages : "all",
            output: output.substring(0, 2000),
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 17: forge_git ====================
  api.registerTool(
    tool(
      "forge_git",
      "Git operations for the project",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          action: {
            type: "string",
            enum: [
              "init",
              "status",
              "commit",
              "pull",
              "branch",
              "merge",
              "log",
            ],
            description: "Git action to perform",
          },
          message: {
            type: "string",
            description: "Commit message (for commit action)",
          },
          branch: {
            type: "string",
            description: "Branch name (for branch/merge actions)",
          },
        },
        required: ["projectId", "action"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const action = params?.action;
        const message = params?.message || "Update via Forge";
        const branch = params?.branch;

        if (!projectId) return { success: false, error: "Missing projectId" };
        if (!action) return { success: false, error: "Missing action" };

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const workdir = project.workdir;
          if (!fs.existsSync(workdir)) {
            return {
              success: false,
              error: "Project workdir does not exist",
              workdir,
            };
          }

          let cmd = "";
          let output = "";

          switch (action) {
            case "init":
              if (!fs.existsSync(path.join(workdir, ".git"))) {
                execSync("git init", { cwd: workdir });
                execSync("git add -A", { cwd: workdir });
                execSync(`git commit -m "Initial commit"`, { cwd: workdir });
                output = "Git repository initialized";
              } else {
                output = "Git repository already exists";
              }
              break;

            case "status":
              output = execSync("git status --short", {
                cwd: workdir,
                encoding: "utf8",
              });
              break;

            case "commit":
              execSync("git add -A", { cwd: workdir });
              try {
                output = execSync(
                  `git diff --cached --quiet && echo "Nothing to commit" || git commit -m "${escapeShellArg(message).slice(1, -1)}"`,
                  { cwd: workdir, encoding: "utf8" },
                );
              } catch (e) {
                output =
                  e.stdout ||
                  e.stderr ||
                  "Commit skipped (no changes or hook rejected)";
              }
              break;

            case "pull":
              output = execSync("git pull", { cwd: workdir, encoding: "utf8" });
              break;

            case "branch":
              if (branch) {
                execSync(
                  `git checkout -b "${escapeShellArg(branch).slice(1, -1)}"`,
                  { cwd: workdir },
                );
                output = `Created and switched to branch: ${branch}`;
              } else {
                output = execSync("git branch -a", {
                  cwd: workdir,
                  encoding: "utf8",
                });
              }
              break;

            case "merge":
              if (!branch)
                return {
                  success: false,
                  error: "Branch name required for merge",
                };
              output = execSync(
                `git merge "${escapeShellArg(branch).slice(1, -1)}"`,
                { cwd: workdir, encoding: "utf8" },
              );
              break;

            case "log":
              output = execSync("git log --oneline -10", {
                cwd: workdir,
                encoding: "utf8",
              });
              break;

            default:
              return { success: false, error: `Unknown action: ${action}` };
          }

          return {
            success: true,
            projectId,
            workdir,
            action,
            output: output.trim(),
          };
        } catch (err) {
          return {
            success: false,
            error: err.message,
            output: err.stdout || err.stderr || "",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 18: forge_template_save ====================
  api.registerTool(
    tool(
      "forge_template_save",
      "Save current project config as a reusable template",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          templateName: {
            type: "string",
            description: "Name for the template",
          },
          description: { type: "string", description: "Template description" },
        },
        required: ["projectId", "templateName"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const templateName = params?.templateName;
        const description = params?.description || "";

        if (!projectId || !templateName) {
          return { success: false, error: "Missing projectId or templateName" };
        }

        const db = await initDB();
        try {
          const project = await get(db, "SELECT * FROM projects WHERE id=?", [
            projectId,
          ]);
          if (!project)
            return { success: false, error: "Project not found", projectId };

          const features = await all(
            db,
            "SELECT id, name, description, priority, dependencies FROM features WHERE project_id=?",
            [projectId],
          );
          const options = JSON.parse(project.options || "{}");

          // 模板目录
          const templateDir = path.join(
            process.env.HOME || "/tmp",
            ".openclaw-gateway",
            "forge-templates",
          );
          if (!fs.existsSync(templateDir)) {
            fs.mkdirSync(templateDir, { recursive: true });
          }

          const templateId = templateName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-");
          const template = {
            id: templateId,
            name: templateName,
            description,
            sourceProject: projectId,
            sourceProjectName: project.name,
            options,
            features: features.map((f) => ({
              name: f.name,
              description: f.description,
              priority: f.priority,
              dependencies: JSON.parse(f.dependencies || "[]"),
            })),
            createdAt: new Date().toISOString(),
          };

          const templateFile = path.join(templateDir, `${templateId}.json`);
          fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));

          logger.info?.(`[forge] Template saved: ${templateId}`);

          return {
            success: true,
            templateId,
            templateName,
            templateFile,
            featureCount: features.length,
            options: template.options,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  // ==================== 工具 19: forge_template_list ====================
  api.registerTool(
    tool(
      "forge_template_list",
      "List all saved templates",
      {
        type: "object",
        properties: {},
      },
      async (params) => {
        const templateDir = path.join(
          process.env.HOME || "/tmp",
          ".openclaw-gateway",
          "forge-templates",
        );

        if (!fs.existsSync(templateDir)) {
          return { success: true, templates: [], count: 0 };
        }

        const templates = [];
        const files = fs
          .readdirSync(templateDir)
          .filter((f) => f.endsWith(".json"));

        for (const file of files) {
          try {
            const content = JSON.parse(
              fs.readFileSync(path.join(templateDir, file), "utf8"),
            );
            templates.push({
              id: content.id,
              name: content.name,
              description: content.description,
              featureCount: content.features?.length || 0,
              language: content.options?.language,
              framework: content.options?.framework,
              createdAt: content.createdAt,
            });
          } catch {}
        }

        return {
          success: true,
          templates,
          count: templates.length,
          templateDir,
        };
      },
    ),
  );

  // ==================== 工具 20: forge_template_load ====================
  api.registerTool(
    tool(
      "forge_template_load",
      "Create a new project from a template",
      {
        type: "object",
        properties: {
          templateId: { type: "string" },
          projectName: {
            type: "string",
            description: "Name for the new project",
          },
          prd: {
            type: "string",
            description: "Additional PRD content (optional)",
          },
          options: { type: "object", description: "Override options" },
        },
        required: ["templateId", "projectName"],
      },
      async (params) => {
        const templateId = params?.templateId;
        const projectName = params?.projectName;
        const extraPrd = params?.prd || "";
        const overrideOptions = params?.options || {};

        if (!templateId || !projectName) {
          return { success: false, error: "Missing templateId or projectName" };
        }

        const templateDir = path.join(
          process.env.HOME || "/tmp",
          ".openclaw-gateway",
          "forge-templates",
        );
        const templateFile = path.join(templateDir, `${templateId}.json`);

        if (!fs.existsSync(templateFile)) {
          return { success: false, error: "Template not found", templateId };
        }

        let template;
        try {
          template = JSON.parse(fs.readFileSync(templateFile, "utf8"));
        } catch {
          return { success: false, error: "Invalid template file", templateId };
        }

        // 合并选项
        const mergedOptions = { ...template.options, ...overrideOptions };

        // 构建 PRD
        let prdContent = `# ${projectName}\n\n`;
        prdContent += `Template: ${template.name}\n\n`;
        if (template.description) {
          prdContent += `## Overview\n${template.description}\n\n`;
        }
        if (extraPrd) {
          prdContent += `${extraPrd}\n\n`;
        }
        prdContent += `## Features\n\n`;

        template.features.forEach((f, i) => {
          const idx = String(i + 1).padStart(3, "0");
          prdContent += `### Feature ${idx}: ${f.name}\n`;
          prdContent += `- **描述**: ${f.description}\n`;
          prdContent += `- **优先级**: P${f.priority}\n`;
          if (f.dependencies && f.dependencies.length > 0) {
            prdContent += `- **依赖**: ${f.dependencies.join(", ")}\n`;
          } else {
            prdContent += `- **依赖**: 无\n`;
          }
          prdContent += `\n`;
        });

        const db = await initDB();
        try {
          const projectId = `proj-${Date.now()}`;
          const workdir = path.join(PROJECTS_DIR, projectId);
          fs.mkdirSync(workdir, { recursive: true });
          fs.writeFileSync(path.join(workdir, "PRD.md"), prdContent);

          await run(
            db,
            `INSERT INTO projects (id, name, prd, status, workdir, options) VALUES (?,?,?,?,?,?)`,
            [
              projectId,
              projectName,
              prdContent,
              "initialized",
              workdir,
              JSON.stringify(mergedOptions),
            ],
          );

          const parsed = parsePRD(prdContent);
          for (const f of parsed.features) {
            await run(
              db,
              `INSERT INTO features (id, project_id, name, description, priority, status, dependencies) VALUES (?,?,?,?,?,?,?)`,
              [
                f.id,
                projectId,
                f.name,
                f.description,
                f.priority,
                "pending",
                JSON.stringify(f.dependencies),
              ],
            );
          }

          logger.info?.(
            `[forge] Project created from template ${templateId}: ${projectId}`,
          );

          return {
            success: true,
            projectId,
            projectName,
            templateId,
            templateName: template.name,
            featureCount: parsed.features.length,
            workdir,
            options: mergedOptions,
            nextStep: "Run forge_plan to design the architecture",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  logger.info?.(
    "[forge] Extension loaded v2.4 - Full PRD → Code Automation (with Templates)",
  );
}
