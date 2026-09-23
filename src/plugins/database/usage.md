# database

## Description

One connection and a handle per plugin over it, configured for a server from
the first write, and tables written once for SQLite and Postgres.

## Purpose

No write is lost to a default nobody chose, and a plugin runs on either
database: its migrations are generated from one definition, once a dialect.

## Usage

```ts
export const items = table("items_items", {
    id: column.id().primaryKey(),
    title: column.text("title").notNull(),
    createdAt: column.timeMs("created_at").notNull(),
}, (self) => [index("items_items_by_created").on(self.createdAt)]);

const store = database({ file: "./data/app.db", tables: { items: { items } } });
await store.migrate([{ plugin: "items", from: "./plugins/items/migrations" }]);
```

- `table`, `column`, `index`, `uniqueIndex` (entry `./tables`): `id`, `text`,
  `integer`, `timeMs` (bigint), `boolean`, `json` (jsonb), `real`. The
  dialect is `KIT_DIALECT`, else Postgres for a Postgres `DATABASE_URL`,
  else SQLite, read on the first `table()`. `ctx.db` is a `PortableDb`.
- `tx` runs work in one transaction; one inside another is a savepoint.
  `tx`, `write` and the outbox's and schedule's own work are serialised, so
  none lands in another's transaction.
- WAL, `foreign_keys` and a busy timeout are set on open.

`start` takes a `Store` as readily as a path; given none, a plugin declaring
tables is refused by name.

## Refuses

- A handle for a plugin with no tables; the database after `close`.
- `migrate` inside an open transaction (`JOINED_TRANSACTION`); SQLite < 3.39.
- A column outside the portable set (`UNPORTABLE_COLUMN`); a database of
  another dialect than the tables (`MIXED_DIALECT`).
- A migration edited after it ran, misnamed, or sharing a number.
