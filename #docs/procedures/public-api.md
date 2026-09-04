# Procedure: public API

What a plugin exposes, and what it never does.

## The rule

`src/plugins/<name>/api.ts` is the only file another plugin may import.
Everything else lives in that plugin's `internal/`.

TypeScript will not stop a deep import, so two things enforce it: `exports`
lists only the package entries, and `tools/boundaries.mjs` refuses a reach
into another plugin's `internal/`, resolving the path rather than matching the
text. No wildcard in `exports`, ever.

## api.ts holds

The types crossing the boundary, the error classes callers match on, and one
factory or accessor.

```ts
export { MigrationFault } from "./internal/migrate";
export type { Handle, Step } from "./internal/store";
export function database(settings: Settings): Store
```

No logic, no state, no work at import time.

## Calling another plugin

Import its `api.ts` and call it: `const store = database(settings)`. What one
plugin builds, it passes to the next rather than reaching for a shared one.

## Factories, not classes

`database(settings)`, not `new Database(settings)`. The factory returns an
interface, so a caller holds the contract, not the implementation.

Dependencies are arguments: never a global, never a singleton. The file path
is a parameter, so two stores exist in one process without seeing each other,
which is what a test needs.

## Types

A public type is owned by the plugin defining it. Never expose an internal
one: if a caller cannot construct it, it is not on the boundary.

`api.ts` and `usage.md` change in one commit, or the contract is a lie.

## Refuses

- Logic, state or import-time work in `api.ts`.
- A public function returning an internal type.
- Importing another plugin's `internal/`.
