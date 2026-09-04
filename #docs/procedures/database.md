# Procedure: database

One connection, and one namespace per plugin over it.

## Tables

A plugin declares its tables in `tables` and reaches them through `ctx.db`.
That handle is built from its own tables alone, so a query naming another
plugin's table does not compile.

Nothing crosses that line. A plugin needing another's data asks its public
API, or listens for what it announced. A join across the boundary is the
boundary gone: the two are one plugin, or were never separate.

Table names are global in SQLite, so prefix them: `items`, `items_tags`. Two
plugins claiming one name is refused at startup.

## Writing

`ctx.tx` for anything touching more than one row, and anything that emits.

```ts
await ctx.tx(async (inside) =>
{
    await inside.db.insert(items).values(row);

    inside.events.emit("items.made", { id: row.id });
});
```

The callback is handed its own context: use that, never the outer. The event
is held until the commit, so a listener never acts on a write that rolled
back.

SQLite takes one writer: keep a transaction short, and never await a network
call inside one.

## Rules

Query through Drizzle. Raw SQL is for migrations, where no user input is
interpolated.

Never order or case-fold non-ASCII text in SQL: SQLite compares code points
and folds only A to Z. See `text.md`.

Scope every read to what the caller may see. A permission says they may read
items, never that this item is theirs.

A row is not output. What leaves is whatever the route's output schema names,
so a column added later stays inside until someone decides otherwise.

## Proving it

Tests use a real in-memory database with the real migrations. A fake accepting
what SQLite rejects is where bugs hide: constraints, types and rollback are
what is worth testing, and a stub has none.
