# database

## Description

One SQLite connection and a handle per plugin over it, with the settings a
server needs from the first write. Or another database, or none.

## Purpose

One connection, configured once, so no write is lost to a default nobody
chose. A handle names its plugin's tables; naming another's won't compile.

## Usage

```ts
const store = database({ file: "./data/app.db", tables: { items } });

await store.migrate([{ plugin: "items", from: "./plugins/items/migrations" }]);

await ctx.tx(async (inside) =>
{
    await inside.db.insert(items).values(row);
    inside.events.emit("items.made", { id: row.id });
});
```

- `forPlugin(plugin)` hands a plugin a Drizzle handle over its own tables.
  `tx` runs work in one transaction, rolled back if it throws; one inside
  another is a savepoint, never a second.
- `tx`, `write` and the outbox's and schedule's own work are serialised: a
  query issued during another's transaction would join it and die with its
  rollback.
- WAL, `foreign_keys` and a busy timeout are set on open; SQLite defaults
  none. `close` ends it.

## Another, or none

`database()` returns a `Store`; the kernel takes `KernelStore`, that minus
`migrate` and `close`.

`start` takes a `Store` as readily as a path, so Postgres or MySQL is one the
project passes: the kernel asks for `forPlugin` and `tx`, never which it got.
Given none, nothing opens, and a plugin declaring tables is refused by name.

## Refuses

- A handle for a plugin that declared no tables, naming it.
- `migrate` inside an open transaction (`JOINED_TRANSACTION`); SQLite < 3.39.
- A migration whose hash no longer matches its file, one outside
  `NNNN-name.sql`, or two sharing a number.
- Reaching the database after `close`, or `ctx.db` where there is none.
