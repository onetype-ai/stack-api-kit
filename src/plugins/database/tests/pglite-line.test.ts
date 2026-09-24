import { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, test, vi } from "vitest";

import { migrationsOf } from "./openStore";

import type { PortableDb, PostgresStore } from "../api";

// PGlite's own: a plugin's async transaction through its handle, which SQLite's driver does not take. The entry is
// loaded afresh under Postgres, since a table is built for the dialect of the moment it is made.
let database: PGlite | undefined;
let stores: PostgresStore[] = [];

afterEach(async () =>
{
    await Promise.all(stores.map((store) => store.close()));
    stores = [];
    await database?.close();
    database = undefined;
    vi.unstubAllEnvs();
});

test("a transaction a plugin opens through its own handle keeps another store's work out of it", async () =>
{
    vi.stubEnv("KIT_DIALECT", "postgres");
    vi.resetModules();
    const { column, postgres, table } = await import("../api");
    const rows = table("items_rows", { id: column.id().primaryKey() });
    type Db = PortableDb<{ rows: typeof rows }>;
    const shared = await PGlite.create();
    database = shared;

    const storeIn = async (schema: string): Promise<PostgresStore> =>
    {
        const store = await postgres({ pglite: shared, schema, tables: { items: { rows } } });

        await store.migrate([{ plugin: "items", from: migrationsOf(`CREATE TABLE "items_rows" ("id" text PRIMARY KEY NOT NULL);`) }]);
        stores.push(store);

        return store;
    };
    const ids = async (from: PostgresStore): Promise<string[]> => (await (from.forPlugin("items") as Db).select().from(rows)).map((row) => row.id).sort();
    const first = await storeIn("line_first");
    const second = await storeIn("line_second");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) =>
    {
        release = resolve;
    });

    const committed = (first.forPlugin("items") as Db).transaction(async (tx) =>
    {
        await tx.insert(rows).values({ id: "first" });
        await held;
        await tx.insert(rows).values({ id: "first-again" });
    });
    const written = second.write(() => (second.forPlugin("items") as Db).insert(rows).values({ id: "second" }));

    release();
    await committed;
    await written;

    expect(await ids(first)).toEqual(["first", "first-again"]);
    expect(await ids(second)).toEqual(["second"]);
}, 60_000);
