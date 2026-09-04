import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, expect, test } from "vitest";

import { database } from "../api";

const rows = sqliteTable("rows", { id: text("id").primaryKey() });

const CREATE = "CREATE TABLE rows (id TEXT PRIMARY KEY)";

const wait = (ms: number): Promise<void> => new Promise((keep) => setTimeout(keep, ms));

let store: ReturnType<typeof database>;

beforeEach(() =>
{
    store = database({ file: ":memory:", tables: { a: { rows }, b: { rows } } });

    (store.of("a") as unknown as { $client: { exec: (sql: string) => void } }).$client.exec(CREATE);
});

afterEach(() =>
{
    store.close();
});

test("a write made outside a transaction survives another transaction's rollback", async () =>
{
    const db = store.of("a");

    const rolling = store.tx("a", async (found) =>
    {
        await (found as typeof db).insert(rows).values({ id: "inside" });
        await wait(20);

        throw new Error("this one rolls back");
    }).catch(() => undefined);

    await wait(5);

    // What the kernel does for every query outside a transaction: without
    // this the insert lands inside the transaction above and dies with it.
    await store.write(async () => { await db.insert(rows).values({ id: "outside" }); });

    await rolling;

    await expect(db.select().from(rows)).resolves.toEqual([{ id: "outside" }]);
});

test("two overlapping transactions both finish rather than one refusing", async () =>
{
    const db = store.of("a");

    const both = await Promise.allSettled([
        store.tx("a", async (found) =>
        {
            await (found as typeof db).insert(rows).values({ id: "first" });
            await wait(20);
        }),
        store.tx("a", async (found) =>
        {
            await wait(5);
            await (found as typeof db).insert(rows).values({ id: "second" });
        }),
    ]);

    expect(both.map((one) => one.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(db.select().from(rows)).resolves.toHaveLength(2);
});

test("one transaction's rollback leaves the other's committed work alone", async () =>
{
    const db = store.of("a");

    await Promise.allSettled([
        store.tx("a", async (found) =>
        {
            await (found as typeof db).insert(rows).values({ id: "kept" });
            await wait(20);
        }),
        store.tx("a", async (found) =>
        {
            await (found as typeof db).insert(rows).values({ id: "dropped" });
            await wait(5);

            throw new Error("rolled back");
        }),
    ]);

    await expect(db.select().from(rows)).resolves.toEqual([{ id: "kept" }]);
});

test("an inner transaction that fails leaves the outer one able to commit", async () =>
{
    const db = store.of("a");

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
    const db = store.of("a");

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
    const db = store.of("a");

    // The first transaction parks on a real gap. Without the call stack
    // deciding what is nested, the next one off the queue reads a counter,
    // believes itself inside this one, and opens a savepoint in a stranger's
    // transaction: "no such savepoint" for a request that did nothing wrong.
    const slow = store.tx("a", async (found) =>
    {
        await (found as typeof db).insert(rows).values({ id: "slow" });
        await wait(30);
    });

    await wait(5);

    const others = await Promise.allSettled([
        store.tx("a", async (found) =>
        {
            await (found as typeof db).insert(rows).values({ id: "second" });
        }),
        store.tx("a", async (found) =>
        {
            await (found as typeof db).insert(rows).values({ id: "third" });
        }),
    ]);

    await slow;

    expect(others.map((one) => one.status)).toEqual(["fulfilled", "fulfilled"]);
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
