# brief

## What this is

One package a Stack API is built on: a kernel that holds the seams, and the
plugins we ship behind it. A library. What the API is, the API writes.

It knows no auth model and no tenancy. A project decides who a caller is and
what a permission means; the kernel enforces what a contract declared.

## Two kinds of plugin

Ours live in `src/plugins/` and ship with the package: `kernel`, `database`,
`http`, `outbound`, `guard`, `mount`. The project's are values it passes to
`createKernel`, and never live here.

## Why a kernel here

Go gets its boundaries from the compiler: an import graph it checks, an
`internal/` it enforces, a build that refuses a cycle. TypeScript has none of
that at runtime, and module side effects run in an order nothing defines.

So a registry is not duplicating the language. It is where the boundary exists
at all, which is why it validates everything before anything starts.

On a server it earns more than that. A plugin that cannot name another's table
cannot read it, and a route whose output schema does not name a column cannot
leak it. Those are mechanical, not agreed.

## Where we are

Six plugins work. 293 tests, every one watched to fail before it was trusted,
and the database ones run against real in-memory SQLite with real migrations.

A project declares plugins with `definePlugin`, brings them up with `start`,
and serves `api.fetch`.

Seven systems have been built on it by agents reading only the documents, in
seven domains, from a helpdesk to subscription billing. Every one shipped
green. What they found is in `done.md`; what nobody has tried is in `todo.md`.

## Next

Somebody trying to break it. Every author so far was building.
