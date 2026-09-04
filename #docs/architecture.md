# architecture

One package a Stack API is built on: the plugins we ship, and the kernel
holding the seams between a project's own.

Read this, then `procedures/`, then the `usage.md` of what you touch.

## Shape

```
src/plugins/<name>/  one capability, behind a declared contract
src/index.ts         the public surface, the one file naming plugins
src/testing/         the checks a project runs on itself
tools/               the checks CI runs
```

A plugin reaches another only through its `api.ts`. `tools/boundaries.mjs`
resolves import paths rather than matching text: a relative path climbing out
of a folder reaches the same private file, and a rule reading the specifier
alone calls it clean.

## Two kinds of plugin

Ours ship with the package: `kernel`, `database`, `http`, `outbound`, `guard`,
`mount`. A project's are values passed to `createKernel`, and never live here.

One plugin is one capability: replace the technology behind it and one folder
changes. Only that folder imports its driver.

## Where the boundary is

A frontend checks to be helpful. We check because nothing else does, so the
guarantees are mechanical: input parsed by a schema, output filtered by one
proven able to filter, errors that never cross as they are, routes closed
until they say otherwise, budgets held by something no plugin can reach, hosts
declared before they are dialled.

A plugin's handle names only its own tables, so a query naming another's does
not compile. The connection underneath is shared, so that boundary is the
compiler's rather than the database's.

## Validation

Everything is checked before anything starts, and every problem reported at
once: four mistakes take one run to learn, not four.

`start` brings up every plugin or throws. Nothing partially starts.
