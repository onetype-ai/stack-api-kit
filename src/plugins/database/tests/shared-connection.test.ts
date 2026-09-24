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

test(`a transaction a plugin opens through its own handle keeps another store's work out of it, on ${dialect()}`, async () =>
{
    const first = await store();
    const second = await store();
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

    expect((await ids(first)).sort()).toEqual(["first", "first-again"]);
    expect(await ids(second)).toEqual(["second"]);
});

