import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { database, MigrationFault } from "../api";

const items = sqliteTable("items", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    count: integer("count").notNull().default(0),
});

/** A folder holding migration files a test wrote. */
function folder(files: Readonly<Record<string, string>>): string
{
    const at = mkdtempSync(join(tmpdir(), "stack-api-migrations-"));

    for (const [name, sql] of Object.entries(files))
    {
        writeFileSync(join(at, name), sql);
    }

    return at;
}

const CREATE = "CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)";

describe("connection", () =>
{
    test("enforces foreign keys, which SQLite leaves off", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        store.migrate([{ plugin: "items", from: folder({ "0001-init.sql": `${CREATE}; CREATE TABLE notes (id TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id))` }) }]);

        const db = store.of("items");

        expect(() => (db as never as { $client: { exec: (sql: string) => void } }).$client
            .exec("INSERT INTO notes (id, item) VALUES ('n1', 'missing')")).toThrow(/FOREIGN KEY/);

        store.close();
    });
});

describe("handles", () =>
{
    let store: ReturnType<typeof database>;

    beforeEach(() =>
    {
        store = database({ file: ":memory:", tables: { items: { items } } });
        store.migrate([{ plugin: "items", from: folder({ "0001-init.sql": CREATE }) }]);
    });

    afterEach(() =>
    {
        store.close();
    });

    test("hands a plugin a handle over its own tables", async () =>
    {
        const db = store.of("items");

        await db.insert(items).values({ id: "a", title: "One" });

        await expect(db.select().from(items)).resolves.toEqual([{ id: "a", title: "One", count: 0 }]);
    });

    test("refuses a plugin that declared no tables, naming it", () =>
    {
        expect(() => store.of("billing")).toThrow(/"billing" asked for a database handle but declares no tables/);
    });

    test("refuses a handle after close", () =>
    {
        store.close();

        expect(() => store.of("items")).toThrow(/after it was closed/);

        store = database({ file: ":memory:", tables: { items: { items } } });
    });
});

describe("transactions", () =>
{
    let store: ReturnType<typeof database>;

    beforeEach(() =>
    {
        store = database({ file: ":memory:", tables: { items: { items } } });
        store.migrate([{ plugin: "items", from: folder({ "0001-init.sql": CREATE }) }]);
    });

    afterEach(() =>
    {
        store.close();
    });

    test("keeps every write when the work finishes", async () =>
    {
        await store.tx("items", async (db) =>
        {
            const found = db as ReturnType<typeof store.of>;

            await found.insert(items).values({ id: "a", title: "One" });
            await found.insert(items).values({ id: "b", title: "Two" });
        });

        await expect(store.of("items").select().from(items)).resolves.toHaveLength(2);
    });

    test("undoes every write when the work throws", async () =>
    {
        await expect(store.tx("items", async (db) =>
        {
            await (db as ReturnType<typeof store.of>).insert(items).values({ id: "a", title: "One" });

            throw new Error("changed my mind");
        })).rejects.toThrow("changed my mind");

        await expect(store.of("items").select().from(items)).resolves.toEqual([]);
    });

    test("undoes the first write when a later one breaks a constraint", async () =>
    {
        await expect(store.tx("items", async (db) =>
        {
            const found = db as ReturnType<typeof store.of>;

            await found.insert(items).values({ id: "a", title: "One" });
            await found.insert(items).values({ id: "a", title: "Again" });
        })).rejects.toThrow();

        await expect(store.of("items").select().from(items)).resolves.toEqual([]);
    });
});

describe("migrations", () =>
{
    test("runs each file once, in the order its number gives", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });
        const from = folder({
            "0001-init.sql": CREATE,
            "0002-seed.sql": "INSERT INTO items (id, title) VALUES ('a', 'One')",
            "0010-more.sql": "INSERT INTO items (id, title) VALUES ('b', 'Two')",
        });

        const ran = store.migrate([{ plugin: "items", from }]);
        const again = store.migrate([{ plugin: "items", from }]);

        expect(ran.map((one) => one.name)).toEqual(["0001-init.sql", "0002-seed.sql", "0010-more.sql"]);
        expect(again).toEqual([]);

        store.close();
    });

    test("refuses a migration whose content changed after it ran", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });
        const from = folder({ "0001-init.sql": CREATE });

        store.migrate([{ plugin: "items", from }]);

        writeFileSync(join(from, "0001-init.sql"), `${CREATE};\n-- edited`);

        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(MigrationFault);
        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(/has changed since it ran/);

        store.close();
    });

    test("refuses a file outside NNNN-name.sql", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        expect(() => store.migrate([{ plugin: "items", from: folder({ "init.sql": CREATE }) }]))
            .toThrow(/not named NNNN-name\.sql/);

        store.close();
    });

    test("refuses two files sharing one number", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        expect(() => store.migrate([{ plugin: "items", from: folder({ "0001-a.sql": CREATE, "0001-b.sql": "SELECT 1" }) }]))
            .toThrow(/share the number 0001/);

        store.close();
    });

    test("leaves the ones before a failure applied and recorded", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });
        const from = folder({ "0001-init.sql": CREATE, "0002-bad.sql": "THIS IS NOT SQL" });

        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(MigrationFault);

        const ran = store.migrate([{ plugin: "items", from: folder({ "0002-ok.sql": "INSERT INTO items (id, title) VALUES ('a', 'One')" }) }]);

        expect(ran).toHaveLength(1);

        store.close();
    });

    test("names the plugin and the file when a migration fails", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        try
        {
            store.migrate([{ plugin: "items", from: folder({ "0001-bad.sql": "NOT SQL AT ALL" }) }]);
            expect.unreachable();
        }
        catch (cause)
        {
            expect((cause as MigrationFault).plugin).toBe("items");
            expect((cause as MigrationFault).step).toBe("0001-bad.sql");
        }

        store.close();
    });
});
