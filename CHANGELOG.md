# Changelog

## 2.6.3 - 2026-02-15

### Fixed

- Added path input whitelist validation in `validateToolParams` to block traversal and malformed path strings.
- Added compound index `idx_runs_feature_id_status` for run lookup by feature and status.
- Added regression coverage for cross-project status isolation.

### Security

- Extended command-injection surface checks for `repoName`, `path`, and `testCommand`.
- Kept whitelist validation compatible and explicit for `packages` and repository visibility.

### Performance

- Minor query-path win from `runs(feature_id, status)` index for status-based run lookups under `forge_status`/`forge_implement`.

### Tests

- Added regression cases:
  - unsafe `repoName` / `path` / `testCommand` rejection
  - `forge_status` project-scoped isolation check

## 2.6.2 - 2026-02-15

### Fixed

- Hardened dependency parsing paths to avoid crashes on malformed dependency payloads (`detectCycle`/`validateDependencies`/`forge_next`/`forge_implement`).
- Added migration idempotency guarantees for legacy schemas by auto-adding missing `runs.started_at` and `runs.completed_at` columns.

### Security

- Added stricter package-name validation (blocks traversal and shell-metacharacter payloads).
- Added audit-log redaction for sensitive keys/values (`token`, `account`, `path`, `workdir`, email-like and token-like strings).
- Kept whitelist checks backward-compatible while reducing command-injection surface for package/test-command inputs.

### Performance

- Improved hot-path robustness without regression and validated higher throughput versus baseline:
  - `forge_status`: p50 `0.436ms` -> `0.040ms`, p95 `0.529ms` -> `0.069ms`, QPS `2175.4` -> `10802.9`
  - `forge_run`: p50 `0.960ms` -> `0.106ms`, p95 `1.126ms` -> `0.207ms`, QPS `1000.6` -> `7349.7`
  - `forge_implement`: p50 `0.236ms` -> `0.105ms`, p95 `0.552ms` -> `0.418ms`, QPS `3121.3` -> `5636.5`

### Reliability

- Added explicit dependency normalization helper and reused it across workflows.
- Kept WebSocket opt-out in test/CI and runtime error resilience.

### Tests

- Expanded regression suite by +6 cases (dependency normalization, malformed input resilience, schema migration idempotency, whitelist traversal blocking, audit redaction).

## 2.6.1 - 2026-02-15

### Fixed

- Fixed `forge_init` crash path when dependency arrays were passed into `safeJSONParse`.
- Fixed feature ID collision across projects by scoping stored feature IDs with `projectId`.
- Added legacy SQLite schema migration guards for missing `runs.started_at/completed_at` columns.
- Removed unsafe sqlite pool shutdown hook that could trigger native close crashes on process exit.

### Security

- Expanded input whitelist checks for `forge_install.packages`, `forge_test.testCommand`, and stricter `repoName` validation.
- Kept command execution on async `exec` and reduced command-injection surface by rejecting unsafe shell characters for user-provided command text.

### Performance

- Optimized `forge_run` by replacing full feature row scan with `COUNT(1)` query.
- Added compound indexes for hot paths:
  - `features(project_id, status, priority, created_at)`
  - `runs(project_id, started_at DESC)`

### Reliability

- Added feature state transition guard helper and enforced transitions for `forge_done` and `forge_retry`.
- Made WebSocket startup safer in test/CI contexts and added runtime error handler.

### Tests

- Added regression tests for:
  - `forge_init` dependency parsing stability
  - project re-init collision safety
  - package whitelist security
  - status transition legality
