# Repository Guidelines

## Project Structure & Module Organization

This repository implements a TypeScript GitHub composite action. `index.ts` coordinates configuration, probing, state updates, filter rewrites, and reporting. Keep focused logic in `sources/` rather than expanding the entry point. Tests live in `tests/` and mirror source modules, such as `sources/verdict.ts` and `tests/verdict.test.ts`. `action.yml` defines the public interface; workflows are under `.github/workflows/`. Lint customization lives in `.oxlintrc.json` and `oxlint-plugin.mjs`.

## Build, Test, and Development Commands

Use pnpm and an active Node.js LTS release, matching CI.

- `pnpm install --no-lockfile` installs dependencies; this project intentionally does not track a lockfile.
- `pnpm test` runs all `tests/**/*.test.ts` files through Node's built-in test runner and `tsx`.
- `pnpm lint` runs Oxlint, including the repository's custom rules.
- `pnpm typecheck` performs strict TypeScript checking without emitting files.
- `pnpm ci` runs `index.ts` directly; supply the action's required environment, notably `GLOBALPING_API_TOKEN`, and use test data or dry-run settings when developing locally.

Run tests, lint, and type checking before opening a pull request.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.ts` extensions for local imports. Follow two-space indentation, single quotes, and no semicolons. The custom linter enforces PascalCase identifiers; examples include `LoadState` and `WorkingDirectory`. Use kebab-case module names such as `candidate-selection.ts`. Keep worker messages serializable and SQLite ownership in the main process.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `<module>.test.ts` and write behavior-focused test names, such as `test('invalid config fails ...', ...)`. Add regression coverage beside every behavioral change. There is no configured numeric coverage threshold, so prioritize relevant success, failure, and boundary cases. Avoid live network dependencies; isolate Globalping behavior with controlled inputs or mocks.

## Commit & Pull Request Guidelines

Recent history primarily uses short Conventional Commit-style subjects such as `feat: ...` and `chore: ...`; use an imperative, scoped summary and keep each commit focused. Pull requests should explain the problem, the behavior change, and verification commands. Link related issues when applicable. Call out changes to `action.yml`, inputs/outputs, permissions, persisted state, or generated reports, and update `README.md` when the public action contract changes. All lint, typecheck, test, and CodeQL checks should pass.

## Security & Configuration Tips

Never commit Globalping tokens, generated state databases, or repository credentials. Treat automatic pull-request creation as privileged behavior: test it only in trusted workflows with the minimum required `contents` and `pull-requests` permissions.
