import { afterEach, expect, test } from "vitest";

import { column, dialect, table } from "../api";
import { migrationsOf, openStore, type OpenedStore } from "./openStore";

import type { PortableDb } from "../api";

const rows = table("items_rows", { id: column.id().primaryKey() });
const CREATE = `CREATE TABLE "items_rows" ("id" text PRIMARY KEY NOT NULL);`;

type Db = PortableDb<{ rows: typeof rows }>;

let opened: OpenedStore[] = [];

afterEach(async () =>
{
    await Promise.all(opened.map((store) => store.close()));
    opened = [];
});

async function store(): Promise<OpenedStore>
{
    const made = await openStore({ items: { rows } });

    await made.migrate([{ plugin: "items", from: migrationsOf(CREATE) }]);
    opened.push(made);

    return made;
}

const ids = async (from: OpenedStore): Promise<string[]> => (await (from.forPlugin("items") as Db).select().from(rows)).map((row) => row.id);

test(`two stores sharing one connection keep their writes apart while one holds a transaction open, on ${dialect()}`, async () =>
{
    const first = await store();
    const second = await store();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) =>
    {
        release = resolve;
    });

    const rolledBack = first.tx("items", async (db) =>
    {
        await (db as Db).insert(rows).values({ id: "first" });
        await held;

        throw new Error("the first store's work failed");
    });
    const written = second.write(() => (second.forPlugin("items") as Db).insert(rows).values({ id: "second" }));

    release();

    await expect(rolledBack).rejects.toThrow("the first store's work failed");
    await written;

    expect(await ids(first)).toEqual([]);
    expect(await ids(second)).toEqual(["second"]);
});

test(`each store reads its own schema however the stores' calls interleave, on ${dialect()}`, async () =>
{
    const first = await store();
    const second = await store();

    await first.write(() => (first.forPlugin("items") as Db).insert(rows).values({ id: "in-first" }));
    await second.write(() => (second.forPlugin("items") as Db).insert(rows).values({ id: "in-second" }));

    const [a, b, c] = await Promise.all([ids(first), ids(second), ids(first)]);

    expect([a, b, c]).toEqual([["in-first"], ["in-second"], ["in-first"]]);
});

test(`a statement failing inside a transaction the plugin turns into its own error leaves the store working, on ${dialect()}`, async () =>
{
    const only = await store();
    const insert = (db: Db, id: string) => db.insert(rows).values({ id });

    await only.tx("items", async (db) => insert(db as Db, "a"));

    const refused = only.tx("items", async (db) =>
    {
        try
        {
            await insert(db as Db, "a");
        }
        catch
        {
            throw new Error("that id is taken");
        }
    });

    await expect(refused).rejects.toThrow("that id is taken");
    await only.tx("items", async (db) => insert(db as Db, "b"));
    expect((await ids(only)).sort()).toEqual(["a", "b"]);
});

