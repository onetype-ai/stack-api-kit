import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { column, dialect, table } from "../api";
import { openStore } from "./openStore";

import type { PortableDb } from "../api";
import type { OpenedStore } from "./openStore";

const rows = table("items_rows", {
    id: column.id().primaryKey(),
    title: column.text("title").notNull(),
    isDone: column.boolean("is_done").notNull().default(false),
    details: column.json<{ tags: string[] }>("details").notNull(),
    at: column.timeMs("at").notNull(),
});

type Db = PortableDb<{ rows: typeof rows }>;

// what drizzle-kit writes for the table above, once a dialect
const MIGRATIONS = {
    "sqlite/0000_items.sql": "CREATE TABLE items_rows (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, is_done INTEGER DEFAULT false NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL);",
    "postgres/0000_items.sql": "CREATE TABLE items_rows (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, is_done BOOLEAN DEFAULT false NOT NULL, details JSONB NOT NULL, at BIGINT NOT NULL);",
};

const LATER = Date.UTC(2090, 0, 1);
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function migrations(): string
{
    const from = mkdtempSync(join(tmpdir(), "kit-store-"));

    for (const [path, text] of Object.entries(MIGRATIONS))
    {
        mkdirSync(join(from, path, ".."), { recursive: true });
        writeFileSync(join(from, path), text);
    }

    return from;
}

const row = (id: string) => ({ id, title: id, details: { tags: ["x"] }, at: LATER });

let store: OpenedStore;

beforeEach(async () =>
{
    store = await openStore({ items: { rows } });
    await store.migrate([{ plugin: "items", from: migrations() }]);
}, 30_000);

afterEach(async () =>
{
    await store.close();
});

const handle = (): Db => store.forPlugin("items") as Db;
const ids = async (): Promise<string[]> => (await handle().select({ id: rows.id }).from(rows).orderBy(rows.id)).map((one) => one.id);

describe(`a store on ${dialect()}`, () =>
{
    test("runs each migration once", async () =>
    {
        const again = await store.migrate([{ plugin: "items", from: migrations() }]);

        expect(again).toEqual([]);
    });

    test("reads back what it wrote: a boolean, JSON, and a time past 2038", async () =>
    {
        await handle().insert(rows).values(row("a"));

        const [kept] = await handle().select().from(rows).where(eq(rows.id, "a"));

        expect(kept).toEqual({ id: "a", title: "a", isDone: false, details: { tags: ["x"] }, at: LATER });
    });

    test("keeps a transaction's work when it returns, and none of it when it throws", async () =>
    {
        await store.tx("items", async (db) =>
        {
            await (db as Db).insert(rows).values(row("kept"));
        });
        await expect(store.tx("items", async (db) =>
        {
            await (db as Db).insert(rows).values(row("gone"));

            throw new Error("the work failed");
        })).rejects.toThrow("the work failed");

        expect(await ids()).toEqual(["kept"]);
    });

    test("makes a transaction inside one a savepoint, whose failure the outer one survives", async () =>
    {
        await store.tx("items", async (db) =>
        {
            await (db as Db).insert(rows).values(row("outer"));
            await store.tx("items", async (inner) =>
            {
                await (inner as Db).insert(rows).values(row("inner"));

                throw new Error("the inner work failed");
            }).catch(() => undefined);
        });

        expect(await ids()).toEqual(["outer"]);
    });

    test("never nests a transaction from another chain: one rolls back, the other's work holds", async () =>
    {
        const failing = store.tx("items", async (db) =>
        {
            await (db as Db).insert(rows).values(row("gone"));
            await wait(30);

            throw new Error("the first work failed");
        });

        await wait(10);
        const holding = store.tx("items", async (db) =>
        {
            await (db as Db).insert(rows).values(row("kept"));
        });

        await expect(failing).rejects.toThrow("the first work failed");
        await holding;

        expect(await ids()).toEqual(["kept"]);
    });

    test("keeps an event the outbox wrote inside a transaction only if the transaction commits", async () =>
    {
        const outbox = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");

        await store.tx("items", async () =>
        {
            await outbox.save(undefined, [{ id: "kept", plugin: "items", name: "items.made", payload: { id: "a" } }]);
        });
        await store.tx("items", async () =>
        {
            await outbox.save(undefined, [{ id: "gone", plugin: "items", name: "items.made", payload: { id: "b" } }]);

            throw new Error("the work failed");
        }).catch(() => undefined);

        expect((await outbox.pending()).map((event) => event.id)).toEqual(["kept"]);
    });

    test("keeps a job claimed while a transaction is open when that transaction rolls back", async () =>
    {
        const jobs = store.schedule?.() ?? expect.unreachable("a store keeps a schedule");
        const now = Date.now();

        await jobs.save(undefined, { id: "job-1", plugin: "items", command: "items.run", input: {}, at: now - 1_000, attempts: 0 });

        const rolledBack = store.tx("items", async () =>
        {
            await wait(50);

            throw new Error("the work failed");
        });
        const claimed = jobs.claim(now, 10);

        await expect(rolledBack).rejects.toThrow("the work failed");
        expect(await claimed).toHaveLength(1);
        expect(await jobs.counts?.(now)).toMatchObject({ due: 0, running: 1 });
    });

    test("lets work a finished transaction left running wait for the next one, instead of joining it", async () =>
    {
        let late: Promise<unknown> = Promise.resolve();

        await store.tx("items", () =>
        {
            late = (async () =>
            {
                await wait(50);
                await store.write(() => handle().insert(rows).values(row("late")));
            })();

            return Promise.resolve();
        });

        const other = store.tx("items", async () =>
        {
            await wait(100);

            throw new Error("the other work failed");
        });

        await expect(other).rejects.toThrow("the other work failed");
        await late;

        expect(await ids()).toEqual(["late"]);
    });
});
