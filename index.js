import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import sqlite3pkg from "sqlite3";

const sqlite3 = sqlite3pkg.verbose();
const DB_PATH = path.join(
  process.env.OPENCLAW_STATE_DIR || "/tmp",
  "autoforge.db",
);

function initDB() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.run(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        prd TEXT,
        status TEXT,
        github_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(
        `CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT,
        description TEXT,
        priority INTEGER,
        status TEXT,
        dependencies TEXT,
        assigned_model TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
        [],
        () => resolve(db),
      );
    });
  });
}

function closeDB(db) {
  try {
    db.close();
  } catch {}
}

function parsePRD(prdContent) {
  if (!prdContent || typeof prdContent !== "string") {
    return { name: "Untitled Project", features: [] };
  }
  const lines = prdContent.split("\n");
  const project = { name: "Untitled Project", features: [] };
  const seenIds = new Set();
  let currentFeature = null;
  let featureCounter = 0;

  for (const line of lines) {
    if (line.startsWith("# ") && project.name === "Untitled Project") {
      project.name = line.replace(/^#\s*/, "").trim() || "Untitled Project";
    }
    if (line.startsWith("### Feature") || line.startsWith("## Feature")) {
      if (currentFeature) {
        if (!seenIds.has(currentFeature.id)) {
          project.features.push(currentFeature);
          seenIds.add(currentFeature.id);
        }
      }
      featureCounter++;
      const match = line.match(/(?:###|##)\s*Feature\s*(\d+)?:?\s*(.+)/i);
      const idx = match?.[1] || String(featureCounter);
      const name = (match?.[2] || `Feature ${idx}`).trim();
      currentFeature = {
        id: `feat-${String(idx).padStart(3, "0")}`,
        name,
        description: "",
        priority: 1,
        dependencies: [],
      };
      continue;
    }
    if (currentFeature && line.startsWith("- **描述**:")) {
      currentFeature.description = line.replace("- **描述**:", "").trim();
    }
    if (currentFeature && line.startsWith("- **优先级**:")) {
      const p = line.replace("- **优先级**:", "").trim();
      currentFeature.priority = p === "P0" ? 0 : p === "P1" ? 1 : 2;
    }
    if (currentFeature && line.startsWith("- **依赖**:")) {
      const deps = line.replace("- **依赖**:", "").trim();
      currentFeature.dependencies =
        !deps || deps === "无"
          ? []
          : deps
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
    }
  }
  if (currentFeature && !seenIds.has(currentFeature.id)) {
    project.features.push(currentFeature);
  }
  return project;
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
          await run(
            db,
            "INSERT INTO projects (id,name,prd,status) VALUES (?,?,?,?)",
            [projectId, parsed.name, prdContent, "initialized"],
          );
          for (const f of parsed.features) {
            await run(
              db,
              "INSERT INTO features (id,project_id,name,description,priority,status,dependencies) VALUES (?,?,?,?,?,?,?)",
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
          return {
            success: true,
            projectId,
            projectName: parsed.name,
            featureCount: parsed.features.length,
            options: {
              architectModel:
                options.architectModel ||
                "anthropic-newcli/claude-opus-4-6-20250528",
              coderModel: options.coderModel || "zhipuai/glm-5",
              reviewerModel:
                options.reviewerModel ||
                "anthropic-newcli/claude-opus-4-6-20250528",
              maxParallel: options.maxParallel || 3,
            },
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_plan",
      "Plan architecture for the project",
      {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        if (!projectId) return { success: false, error: "Missing projectId" };
        const db = await initDB();
        try {
          const project = await get(
            db,
            "SELECT id, name, status FROM projects WHERE id=?",
            [projectId],
          );
          if (!project)
            return { success: false, error: "Project not found", projectId };
          return {
            success: true,
            projectId,
            projectName: project.name,
            message: "Architecture planning checkpoint created.",
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_next",
      "Get next feature to implement (dependency-aware)",
      {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        if (!projectId) return { success: false, error: "Missing projectId" };
        const db = await initDB();
        try {
          const features = await all(
            db,
            "SELECT * FROM features WHERE project_id=? AND status=? ORDER BY priority ASC, created_at ASC",
            [projectId, "pending"],
          );
          const pendingIds = new Set(features.map((f) => f.id));
          const completeIds = new Set(
            (
              await all(
                db,
                "SELECT id FROM features WHERE project_id=? AND status=?",
                [projectId, "complete"],
              )
            ).map((f) => f.id),
          );
          const next =
            features.find((f) => {
              const deps = JSON.parse(f.dependencies || "[]");
              return deps.every(
                (d) => completeIds.has(d) || !pendingIds.has(d),
              );
            }) || null;
          return {
            success: true,
            nextFeature: next,
            pendingCount: features.length,
            readyCount: next ? 1 : 0,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_claim",
      "Claim a feature for implementation",
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
        const model = params?.model || "zhipuai/glm-5";
        if (!featureId) return { success: false, error: "Missing featureId" };
        const db = await initDB();
        try {
          const existing = await get(
            db,
            "SELECT id, status, project_id FROM features WHERE id=?",
            [featureId],
          );
          if (!existing)
            return { success: false, error: "Feature not found", featureId };
          if (existing.status === "complete")
            return {
              success: false,
              error: "Feature already complete",
              featureId,
            };
          const result = await run(
            db,
            "UPDATE features SET status=?, assigned_model=? WHERE id=?",
            ["in_progress", model, featureId],
          );
          return {
            success: true,
            featureId,
            status: "in_progress",
            model,
            projectId: existing.project_id,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_done",
      "Mark a feature as complete",
      {
        type: "object",
        properties: { featureId: { type: "string" } },
        required: ["featureId"],
      },
      async (params) => {
        const featureId = params?.featureId;
        if (!featureId) return { success: false, error: "Missing featureId" };
        const db = await initDB();
        try {
          const existing = await get(
            db,
            "SELECT id, status, project_id FROM features WHERE id=?",
            [featureId],
          );
          if (!existing)
            return { success: false, error: "Feature not found", featureId };
          if (existing.status === "complete")
            return {
              success: true,
              featureId,
              status: "complete",
              message: "Already complete",
            };
          await run(db, "UPDATE features SET status=? WHERE id=?", [
            "complete",
            featureId,
          ]);
          return {
            success: true,
            featureId,
            status: "complete",
            projectId: existing.project_id,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_status",
      "View project progress",
      {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
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
          const allFeatures = await all(
            db,
            "SELECT id, name, status, priority FROM features WHERE project_id=? ORDER BY priority, created_at",
            [projectId],
          );
          return {
            success: true,
            project,
            featureCounts: counts,
            features: allFeatures,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_run",
      "Run full automation: plan → implement → review → push",
      {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        if (!projectId) return { success: false, error: "Missing projectId" };
        return {
          success: true,
          projectId,
          workflow: [
            { step: 1, tool: "forge_plan", description: "Plan architecture" },
            { step: 2, tool: "forge_next", description: "Get next feature" },
            { step: 3, tool: "forge_claim", description: "Claim feature" },
            { step: 4, tool: "forge_done", description: "Mark complete" },
            { step: 5, tool: "forge_review", description: "Code review" },
            { step: 6, tool: "forge_push", description: "Push to GitHub" },
          ],
          note: "Use forge_next/forge_claim/forge_done in loop for each feature",
        };
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_review",
      "Run code review on completed features",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          featureId: { type: "string" },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const featureId = params?.featureId || null;
        if (!projectId) return { success: false, error: "Missing projectId" };
        const db = await initDB();
        try {
          const project = await get(
            db,
            "SELECT id, name FROM projects WHERE id=?",
            [projectId],
          );
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
          return {
            success: true,
            projectId,
            projectName: project.name,
            reviewTarget: featureId || "all completed features",
            featuresToReview: features.length,
            features,
          };
        } finally {
          closeDB(db);
        }
      },
    ),
  );

  api.registerTool(
    tool(
      "forge_push",
      "Push code to GitHub repository",
      {
        type: "object",
        properties: {
          projectId: { type: "string" },
          repoName: { type: "string" },
          visibility: { type: "string", enum: ["public", "private"] },
        },
        required: ["projectId"],
      },
      async (params) => {
        const projectId = params?.projectId;
        const repoName = params?.repoName;
        const visibility = params?.visibility || "private";
        if (!projectId) return { success: false, error: "Missing projectId" };
        try {
          execSync("gh --version", { stdio: "ignore" });
        } catch {
          return {
            success: false,
            projectId,
            error: "GitHub CLI (gh) not installed. Run: brew install gh",
          };
        }
        const safeRepoName = repoName
          ? escapeShellArg(repoName)
          : "<repo-name>";
        const visibilityFlag =
          visibility === "public" ? "--public" : "--private";
        return {
          success: true,
          projectId,
          command: `gh repo create ${safeRepoName} ${visibilityFlag} --source=. --push`,
          visibility,
          note: "Ensure you are in the project directory before running the command",
        };
      },
    ),
  );
}
