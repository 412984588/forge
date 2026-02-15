# Changelog

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
