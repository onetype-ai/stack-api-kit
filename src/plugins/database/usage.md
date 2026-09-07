# database

## Description

One SQLite connection and a handle per plugin over it, with the settings a
server needs from the first write. Or another database, or none at all.

## Purpose

Every plugin otherwise opens its own connection and picks its own journal
mode; one, configured once, is how a write is never lost to a default nobody
chose. A handle names its plugin's tables, so naming another's does not
compile.

## Usage

```ts
const store = database({ file: "./data/app.db", tables: { items } });

store.migrate([{ plugin: "items", from: "./plugins/items/migrations" }]);

await ctx.tx(async (inside) =>
{
    await inside.db.insert(items).values(row);
    inside.events.emit("items.made", { id: row.id });
});
```

- `of(plugin)` hands a plugin a Drizzle handle over its own tables. `tx` runs
  work in one transaction, rolled back if it throws; one inside another is a
  savepoint, never a second.
- `tx` and `write` are serialised: a transaction belongs to the connection,
  not the call that opened it, so a query issued during another's would join
  it and die with its rollback.
- WAL, `foreign_keys` and a busy timeout are set on open; SQLite defaults
  none. `close` finishes it.

## Another, or none

`database()` returns a `Store`; the kernel takes `Storage`, the same minus
`migrate` and `close`.

`start` takes a `Store` as readily as a path, so Postgres or MySQL is one the
project passes: the kernel asks for `of` and `tx`, never which it got. Given
none, nothing opens, and a plugin declaring tables is refused by name.

## Refuses

- A handle for a plugin that declared no tables, naming it.
- A migration whose hash no longer matches its file, one outside
  `NNNN-name.sql`, or two sharing a number.

- Reaching the database after `close`, or `ctx.db` where there is none.
