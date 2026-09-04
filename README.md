# stack-api-kit

One package a Stack API is built on. A kernel that holds the seams, and the
plugins we ship behind it.

This is a library. It carries no routes, no tables and no features: what the
API is, the API writes.

## Install

```sh
npm install @onetype/stack-api-kit better-sqlite3 drizzle-orm hono zod
```

Those four are peers, so a project holds one copy of each and the kit holds
none.

## Use

```ts
import { discover, start } from "@onetype/stack-api-kit";

const api = await start({
    plugins: discover(import.meta.glob("./plugins/*/plugin.ts")),
    database: { file: "./data/app.db" },
    identify: (kernel) => (c) => Sessions.of(kernel, c.req.header("cookie")),
});

export default { fetch: api.fetch, port: 3000 };
```

`identify` is given the started kernel, so it may ask a plugin who this is.

`start` opens the database, migrates in dependency order, validates every
contract, and either starts every plugin or throws naming the one that failed.

Two entries: `.` is everything, `./testing` the checks a project runs on
itself.

A plugin declares everything crossing its boundary: dependencies, tables,
routes, events, hooks, config, and the hosts it may call. What is not declared
does not exist, and the kernel refuses it before anything starts.

## Work on it

`#docs/architecture.md` is the map, `#docs/procedures/` the rules, and each
plugin's `usage.md` its contract. That is the whole context needed for one
plugin.

```sh
tools/check.sh
```

Runs what CI runs: types, tests, the 1800-character limit, and the plugin
boundaries.

Every check here was broken on purpose and watched to fail. One never seen red
proves only that it runs.
