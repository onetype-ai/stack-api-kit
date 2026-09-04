# Procedure: migrations

A migration is history. What ran once ran everywhere, and cannot be rewritten.

## Files

One folder per plugin, named in the contract:

```
plugins/items/migrations/
    0001-create-items.sql
    0002-add-status.sql
```

`NNNN-name.sql`, four digits, lowercase. A name outside that is refused rather
than sorted somewhere: "2-b.sql" sorts before "10-a.sql" as text and after it
as a number, and a schema depending on which is one nobody can reproduce.

Two files sharing a number is refused for the same reason.

## Order

They run in dependency order, so a plugin's tables exist before one depending
on it references them. Within a plugin, the number decides.

Each runs in its own transaction: a failure leaves the ones before it applied
and recorded, so the next run continues rather than starting over.

## Never edit one that ran

The content is hashed when it runs. Changing it afterwards is refused, because
a file edited after it ran leaves one database with the old shape and another
with the new, and both report they are current.

Add a new file. A mistake in production is fixed forwards.

## Writing one

Raw SQL, because there is no user input here to interpolate. One subject per
file: a table, a column, an index.

Write the down migration nowhere. SQLite cannot drop a column without
rewriting the table, and a rollback that has never run is a rollback that does
not work. Recovery is a restore and a new migration forwards.

Seed data belongs in a migration only when the application cannot start
without it. Anything else is a fixture.

## Proving it

Run them against an empty in-memory database in a test, then run them again:
the second run applies nothing. Break one on purpose and watch the failure
name the plugin and the file.
