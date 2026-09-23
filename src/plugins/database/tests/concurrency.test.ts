import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, expect, test } from "vitest";

import { database } from "../api";
import { refuseOldSqlite } from "../internal/connect";

const rows = sqliteTable("rows", { id: text("id").primaryKey() });

const CREATE = "CREATE TABLE rows (id TEXT PRIMARY KEY)";

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Db = ReturnType<ReturnType<typeof database>["forPlugin"]>;

let store: ReturnType<typeof database>;

beforeEach(() =>
{
    store = database({ file: ":memory:", tables: { a: { rows }, b: { rows } } });

    (store.forPlugin("a") as unknown as { $client: { exec: (sql: string) => void } }).$client.exec(CREATE);
});

afterEach(async () =>
{
    await store.close();
});

test("a write made outside a transaction survives another transaction's rollback", async () =>
{
    const db = store.forPlugin("a");

    const rolling = store.tx("a", async (inside) =>
    {
        await (inside as typeof db).insert(rows).values({ id: "inside" });
        await wait(20);

        throw new Error("this one rolls back");
    }).catch(() => undefined);

    await wait(5);

    // What the kernel does for every query outside a transaction: without this the insert lands inside the transaction above and dies with it.
    await store.write(async () => { await db.insert(rows).values({ id: "outside" }); });

    await rolling;

    await expect(db.select().from(rows)).resolves.toEqual([{ id: "outside" }]);
});

test("two overlapping transactions both finish rather than one refusing", async () =>
{
    const db = store.forPlugin("a");

    const both = await Promise.allSettled([
        store.tx("a", async (inside) =>
        {
            await (inside as typeof db).insert(rows).values({ id: "first" });
            await wait(20);
        }),
        store.tx("a", async (inside) =>
        {
            await wait(5);
            await (inside as typeof db).insert(rows).values({ id: "second" });
        }),
    ]);

    expect(both.map((settled) => settled.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(db.select().from(rows)).resolves.toHaveLength(2);
});

test("one transaction's rollback leaves the other's committed work alone", async () =>
{
    const db = store.forPlugin("a");

    await Promise.allSettled([
        store.tx("a", async (inside) =>
        {
            await (inside as typeof db).insert(rows).values({ id: "committed" });
            await wait(20);
        }),
        store.tx("a", async (inside) =>
        {
            await (inside as typeof db).insert(rows).values({ id: "dropped" });
            await wait(5);

            throw new Error("rolled back");
        }),
    ]);

    await expect(db.select().from(rows)).resolves.toEqual([{ id: "committed" }]);
});

test("an inner transaction that fails leaves the outer one able to commit", async () =>
{
    const db = store.forPlugin("a");

    await store.tx("a", async (outer) =>
    {
        await (outer as typeof db).insert(rows).values({ id: "outer" });

        await store.tx("a", async (inner) =>
        {
            await (inner as typeof db).insert(rows).values({ id: "inner" });

            throw new Error("the inner work failed");
        }).catch(() => undefined);
    });

    await expect(db.select().from(rows)).resolves.toEqual([{ id: "outer" }]);
});

test("a transaction from another plugin inside one joins rather than refusing", async () =>
{
    const db = store.forPlugin("a");

    await store.tx("a", async (outer) =>
    {
        await (outer as typeof db).insert(rows).values({ id: "from-a" });

        await store.tx("b", async (inner) =>
        {
            await (inner as typeof db).insert(rows).values({ id: "from-b" });
        });
    });

    await expect(db.select().from(rows)).resolves.toHaveLength(2);
});

test("a transaction waiting on something slow does not make the next one nested", async () =>
{
    const db = store.forPlugin("a");

    // Without the call stack deciding what is nested, the next transaction off the queue opens a savepoint in a stranger's: "no such savepoint" for a request that did nothing wrong.
    const slow = store.tx("a", async (inside) =>
    {
        await (inside as typeof db).insert(rows).values({ id: "slow" });
        await wait(30);
    });

    await wait(5);

    const others = await Promise.allSettled([
        store.tx("a", async (inside) =>
        {
            await (inside as typeof db).insert(rows).values({ id: "second" });
        }),
        store.tx("a", async (inside) =>
        {
            await (inside as typeof db).insert(rows).values({ id: "third" });
        }),
    ]);

    await slow;

    expect(others.map((settled) => settled.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(db.select().from(rows)).resolves.toHaveLength(3);
});

test("a transaction knows it is inside one, and work beside it does not", async () =>
{
    const seen: boolean[] = [];

    await store.tx("a", async () =>
    {
        seen.push(store.inTransaction());

        await wait(5);

        seen.push(store.inTransaction());
    });

    seen.push(store.inTransaction());

    expect(seen).toEqual([true, true, false]);
});

test("the connection is left outside a transaction once the work is done", async () =>
{
    await store.tx("a", () => Promise.resolve());

    expect(store.inTransaction()).toBe(false);

    await store.tx("a", () => Promise.reject(new Error("failed"))).catch(() => undefined);

    expect(store.inTransaction()).toBe(false);
});

test("two apps in one process on one file both finish, where one waits for the other's write lock", async () =>
{
    const folder = mkdtempSync(join(tmpdir(), "kit-two-apps-"));
    const file = join(folder, "app.db");
    const first = database({ file, tables: { a: { rows } } });
    const second = database({ file, busyMs: 2_000, tables: { a: { rows } } });

    first.forPlugin("a").$client.exec(CREATE);

    const holding = first.tx("a", async (db) =>
    {
        await (db as Db).insert(rows).values({ id: "first" });
        await wait(100);
    });
    const waiting = second.tx("a", async (db) =>
    {
        await (db as Db).insert(rows).values({ id: "second" });
    });

    await Promise.all([holding, waiting]);

    const kept = await first.forPlugin("a").select().from(rows);

    expect(kept.map((row) => row.id).sort()).toEqual(["first", "second"]);

    await first.close();
    await second.close();
    rmSync(folder, { recursive: true, force: true });
});

test("a job claimed while a transaction is open keeps its claim when that transaction rolls back", async () =>
{
    const jobs = store.schedule?.();
    const now = Date.now();

    await jobs?.save(undefined, { id: "job-1", plugin: "a", command: "a.run", input: {}, at: now - 1_000, attempts: 0 });

    const rolledBack = store.tx("a", async () =>
    {
        await wait(50);

        throw new Error("the work failed");
    });
    const claimed = jobs?.claim(now, 10);

    await expect(rolledBack).rejects.toThrow("the work failed");
    expect(await claimed).toHaveLength(1);
    expect(await jobs?.counts?.(now)).toMatchObject({ due: 0, running: 1 });
});

test("SQLite older than 3.39 is refused by name, and newer ones are taken", () =>
{
    expect(() => refuseOldSqlite("3.38.5")).toThrow("SQLite 3.38.5 is older than 3.39");
    expect(() => refuseOldSqlite("3.39.0")).not.toThrow();
    expect(() => refuseOldSqlite("4.0.0")).not.toThrow();
});

