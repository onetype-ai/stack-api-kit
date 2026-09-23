# Procedure: database

One connection, and one namespace per plugin over it.

## Tables

A plugin declares its tables in `tables` and reaches them through `ctx.db`.
That handle is built from its own tables alone, so a query naming another
plugin's table does not compile.

Nothing crosses that line. A plugin needing another's data asks its public
API, or listens for what it announced. A join across the boundary is the
boundary gone: the two are one plugin, or were never separate.

A table's name in the database is global, so prefix it there: `items_tags`,
declared as `tags`. Two plugins landing on one name is refused at startup.

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

Keep a transaction short, and never await a network call inside one. SQLite
3.39 or newer. Load the environment before importing plugins
(`node --env-file=.env`): the dialect is read on the first `table()`.

## Rules

Query through Drizzle. Raw SQL is for migrations, where no user input is
interpolated.

Never order or case-fold non-ASCII text in SQL: SQLite compares code points
and folds only A to Z. See `text.md`.

A row is not output: what leaves is what the route's output schema names.

## Proving it

Tests use a real in-memory database with the real migrations. A fake accepting
what SQLite rejects is where bugs hide: constraints, types and rollback are
what is worth testing, and a stub has none.
