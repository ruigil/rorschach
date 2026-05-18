# Repository Guidelines

## Project Structure & Module Organization

Rorschach is a Bun-based TypeScript actor system. Core actor primitives live in `src/system`, shared configuration starts in `src/config.ts`, and the CLI entry point is `src/index.ts`. Feature areas are organized as plugins under `src/plugins`, such as `cognitive`, `memory`, `tools`, `interfaces`, `observability`, `auth`, and `googleapis`. Browser-facing assets are in `src/public`. Tests live in `src/tests`, with fixtures in `src/tests/fixtures`. Examples are in `src/examples`, architecture notes in `docs`, benchmarks in `benchmarks`, and runtime/local state in `workspace`.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run dev` or `bun run rorschach`: run `src/index.ts` locally.
- `bun test`: run the Bun test suite in `src/tests`.
- `bun test --watch` or `bun run test:watch`: rerun tests while editing.
- `bun run test:coverage`: run tests with coverage output.
- `bun run typecheck`: run `tsc --noEmit` using the strict project config.
- `bun run build`: bundle `src/index.ts` to `dist/index.js`.

## Coding Style & Naming Conventions

Use TypeScript with strict types and explicit `.ts` import extensions for local modules. Match the existing style: two-space indentation, single quotes, no semicolons, and `const` for immutable bindings. Prefer small typed message unions, `readonly` fields where useful, and plugin files named by capability, for example `memory.plugin.ts` or `routes.ts`. Keep actor and tool behavior isolated behind typed messages rather than shared mutable state.

## Testing Guidelines

Tests use `bun:test` and are named `*.test.ts` under `src/tests`. Group behavior with `describe`, use short async settling helpers when testing actor mailboxes, and shut down spawned systems at the end of tests. Add focused tests next to the relevant subsystem when changing actor lifecycle, routing, plugin configuration, tool invocation, memory, or browser/API behavior.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, especially `feat:` and `refactor:` subjects, for example `feat: implement dynamic config form rendering and schema management`. Keep subjects imperative and scoped to the behavior changed. Pull requests should include a concise description, test results such as `bun test` and `bun run typecheck`, linked issues when applicable, and screenshots for visible `src/public` UI changes. Note any config or workspace-state migration steps explicitly.

## Frontend Component Conventions

Browser UI is built with native Web Components under `src/public/js/components/`.

- **Shadow DOM** for self-contained primitives with encapsulated styles (`RorschachElement` base class).
- **Light DOM** for domain components that rely on global CSS classes (`LightElement` base class).
- All components register with a guard: `if (!customElements.get('r-foo')) { customElements.define('r-foo', RFoo) }`.
- Components export their class for barrel re-export in `components/index.js`.
- `ICONS` map in `base.js` is the single source of truth for SVG icons.
- Components fire `CustomEvent` with `bubbles: true` for parent communication (e.g. `chat-submit`, `actor-select`).
- `observable-store.js` wraps `state.js` for reactive state subscriptions.
- `connection.js` dispatches typed events to component instances rather than calling module functions directly.

## Security & Configuration Tips

Treat `.env`, `config.json`, and files under `workspace` as local/runtime state. Do not commit secrets, OAuth tokens, generated histories, or machine-specific credentials. When adding plugins, document required config keys and keep default behavior safe when credentials are absent.
