# mount

## Description

Brings an API up in one call: database, migrations, kernel, plugins, server.

## Purpose

Every project otherwise writes the same sixty lines to start: open a database,
collect what each plugin owns, migrate in dependency order, build a kernel,
start it, then mount its routes. None of that differs between projects, and
the order is easy to get subtly wrong.

## Usage

```ts
import { discover, start } from "@onetype/stack-api-kit";

const api = await start({
    plugins: discover(import.meta.glob("./plugins/*/plugin.ts")),
    database: { file: "./data/app.db" },
    http: { origins: ["https://app.example.com"] },
});

export default { fetch: api.fetch, port: 3000 };
```

- The database opens and migrates **before** any plugin runs, in dependency
  order, so a `setup` that reads a table finds one. `database` takes a path,
  or a `Store` of your own for Postgres. Left out, nothing opens and a plugin
  declaring tables is refused by name.
- Who is calling comes from whichever plugin declared `identifies`, so this
  file names no plugin and cannot go stale when one is replaced. `identify`
  here overrides it, and is given the started kernel.
- The kernel starts **before** the server is built, so a refused contract
  stops everything with no route mounted.
- `limits: false` allows every request and says so loudly at startup. The
  numbers stay in the routes; what changes is whether anything counts them.
- `stop` unwinds the plugins, then closes the database.

## Refuses

- A module under the glob with no default export, naming the path.
- Whatever migrations refuse: a changed file, a bad name, a failing step.
- Whatever the kernel refuses: `start` throws it unchanged, naming the plugin,
  the key and the fix.
