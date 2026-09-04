# database

## Description

One SQLite connection, one handle per plugin over it, and the settings a
server needs from the first write.

## Purpose

Every plugin otherwise opens its own connection, picks its own journal mode,
and learns about locking the first busy afternoon. One connection, configured
once, is the only way a write is never lost to a default nobody chose.

A plugin's handle names its own tables, so a query naming another's does not
compile. The connection under it is shared: that boundary is the compiler's,
not the database's.

## Usage

```ts
const store = database({ file: "./data/app.db", tables: { items } });

store.migrate([{ plugin: "items", from: "./plugins/items/migrations" }]);
```

```ts
await ctx.tx(async (inside) =>
{
    await inside.db.insert(items).values(row);

    inside.events.emit("items.made", { id: row.id });
});
```

- `of(plugin)` hands a plugin a Drizzle handle over its own tables.
- `tx` runs work in one transaction, rolled back if anything throws. One
  inside another is a savepoint, never a second transaction.
- `tx` and `write` are serialised. A transaction belongs to the connection,
  not the call that opened it, so a query issued during someone else's would
  join it and die with its rollback, having reported success.
- WAL, `foreign_keys` and a busy timeout are set on open: SQLite defaults none
  of them, and a server wants all three.
- `close` finishes the connection.

`database()` returns a `Store`. The kernel takes `Storage`: the same without
`migrate` or `close`, which no plugin should reach.

## Refuses

- A handle for a plugin that declared no tables, naming it.
- A migration whose hash no longer matches the file.
- A migration outside `NNNN-name.sql`, or two sharing a number.
- Reaching the database after `close`.
