# mount

## Description

Brings an API up in one call: database, migrations, kernel, plugins, server.

## Purpose

Every project otherwise writes the same sixty lines to start: open a database,
collect what each plugin owns, run migrations in dependency order, build a
kernel, start it, then mount its routes. None of that differs between
projects, and the order is easy to get subtly wrong.

## Usage

```ts
import { discover, start } from "@onetype/stack-api-kit";

const api = await start({
    plugins: await discover(import.meta.glob("./plugins/*/plugin.ts")),
    database: { file: "./data/app.db" },
    identify: (kernel) => (c) => Auth.session(kernel.context("auth"), c.req.header("cookie")),
    http: { origins: ["https://app.example.com"] },
});

export default { fetch: api.fetch, port: 3000 };
```

- The database opens and migrates **before** any plugin runs, so a `setup`
  that reads a table finds one.
- `identify` is given the started kernel, so what reads a session reaches the
  plugin holding one. It is built after `start`, never before.
- Migrations run in dependency order, so a plugin's tables exist before one
  depending on it references them.
- The kernel starts **before** the server is built, so a refused contract
  stops everything with no route mounted.
- `stop` unwinds the plugins, then closes the database.

## Refuses

- A module under the glob with no default export, naming the path.
- Whatever migrations refuse: a changed file, a bad name, a failing step.
- Whatever the kernel refuses: `start` throws it unchanged, naming the plugin,
  the key and the fix.
