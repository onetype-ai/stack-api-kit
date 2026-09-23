# Procedure: migrations

A migration is history. What ran once ran everywhere, and cannot be rewritten.

## Files

One folder per plugin, named in the contract, with one folder a dialect:

```
plugins/items/migrations/
    sqlite/0000_items.sql
    postgres/0000_items.sql
```

Both are generated from the plugin's `table()` definitions, never written
twice by hand: `drizzle-kit generate` once with `dialect: "sqlite"` and once
with `"postgresql"`, `KIT_DIALECT` set to match. They hold the same numbered
steps, and `[migrations]` names a gap. One folder of files, the layout before
9.0, runs on SQLite alone.

`NNNN-name.sql` or drizzle-kit's `NNNN_name.sql`, four digits, lowercase. A
name outside that is refused rather than sorted somewhere: "2-b.sql" sorts
before "10-a.sql" as text and after it as a number. Two files sharing a
number are refused for the same reason.

## Order

They run in dependency order, so a plugin's tables exist before one depending
on it references them. Within a plugin, the number decides. All of them run in
one transaction: one that fails takes every step of that run back with it.

## Never edit one that ran

The content is hashed when it runs. Changing it afterwards is refused: one
database would keep the old shape and another the new, both reporting they
are current. Add a new one. A mistake in production is fixed forwards.

## Writing one

Generated, then read before it is committed. Write no down migration: a
rollback that has never run does not work. Recovery is a restore and a new
migration forwards. Seed data only when the application cannot start without
it; anything else is a fixture.

## Proving it

Run them against an empty database in a test, then again: the second run
applies nothing.
