# Procedure: dependencies

Every dependency is carried by every project that installs us, forever. The
cheapest one is the one not taken.

## Between our plugins

A plugin reaches another only through its `api.ts`, so the graph is visible in
the imports and `tools/boundaries.mjs` refuses a cycle.

`mount` composes them, because composing is its capability. Everything else is
built by whoever needs it and passed on: a plugin reaching for a shared
instance is one two tests cannot isolate.

## Drivers stay inside one plugin

Only the plugin that owns a driver imports it: `better-sqlite3` and
`drizzle-orm` belong to `database`, `hono` to `http`. Everything else reaches
them through the kernel's context.

A second plugin importing one is a second boundary, with its own connection,
its own settings and its own idea of a transaction. The checks refuse it.

That is what makes them replaceable: swapping SQLite changes one folder.

## From outside

Runtime dependencies are close to none, and every driver is a peer: the
project installs it, so we never force a version or ship a second copy.

Before adding one: does the platform already do it? `fetch`, `URL`, `crypto`
and `AbortController` are here. Is it smaller to write the part we use? Would
we still take it at ten times the size?

Take one where the problem is genuinely hard: correctness to prove, or a
specification to reimplement. Never one that saves typing.

## Side effects

`"sideEffects": false`, and it must be true: a module doing work on import
cannot be dropped, so a project taking one entry pays for all of them.

## Refuses

- A cycle between our plugins.
- A driver imported outside the plugin that owns it.
- A runtime dependency for something the platform does.
- A driver as a dependency rather than a peer.
