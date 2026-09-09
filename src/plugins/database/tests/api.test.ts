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

        expect(ran.map((step) => step.name)).toEqual(["0001-init.sql", "0002-seed.sql", "0010-more.sql"]);
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

    test("rolls every one of them back when one fails", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });
        const from = folder({ "0001-init.sql": CREATE, "0002-bad.sql": "THIS IS NOT SQL" });

        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(MigrationFault);

        // The database is as it was: 0001 is not applied, so its author can
        // still correct it. Recorded, the hash guard would refuse the edit.
        expect(() => store.of("items").select().from(items).all()).toThrow(/no such table/);

        store.close();
    });

    test("lets the author correct an earlier file after a later one failed", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });
        const from = folder({ "0001-init.sql": CREATE, "0002-bad.sql": "THIS IS NOT SQL" });

        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(MigrationFault);

        writeFileSync(join(from, "0001-init.sql"), `${CREATE.replace(")", ", extra TEXT)")}`);
        writeFileSync(join(from, "0002-bad.sql"), "INSERT INTO items (id, title) VALUES ('a', 'One')");

        expect(store.migrate([{ plugin: "items", from }])).toHaveLength(2);

        store.close();
    });

    test("refuses a migration that leaves a table nothing can write to", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        // SQLite takes this at CREATE and refuses at the first write, so the
        // migration would pass and every insert afterwards would fail.
        const from = folder({
            "0001-init.sql": "CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL, count INTEGER NOT NULL, CHECK (count >= 0 OR RAISE(ABORT, 'count must not be negative')))",
        });

        expect(() => store.migrate([{ plugin: "items", from }])).toThrow(/nothing can write to it/);

        // Rolled back with it, so the author can correct the file: recorded,
        // the hash guard would refuse the edit.
        expect(() => store.of("items").select().from(items).all()).toThrow(/no such table/);

        writeFileSync(join(from, "0001-init.sql"), CREATE);

        expect(store.migrate([{ plugin: "items", from }])).toHaveLength(1);

        store.close();
    });

    test("leaves a plain CHECK and a trigger that raises alone", () =>
    {
        const store = database({ file: ":memory:", tables: { items: { items } } });

        // The word appears in the table's own SQL as a column name and in a
        // default, which is why compiling an insert is the proof rather than
        // reading the text.
        const from = folder({
            "0001-init.sql": "CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'we RAISE the bar', count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0))",
            "0002-guard.sql": "CREATE TRIGGER items_guard BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'count must not be negative') WHERE NEW.count < 0; END",
        });

        expect(store.migrate([{ plugin: "items", from }])).toHaveLength(2);

        store.close();
    });

    test("says so when another process holds the write lock", () =>
    {
        // A file, not :memory:, because the lock is what two processes share.
        const file = join(mkdtempSync(join(tmpdir(), "stack-api-locked-")), "app.db");
        const holder = database({ file, tables: { items: { items } } });
        const waiting = database({ file, busyMs: 50, tables: { items: { items } } });

        // What the other boot is doing: holding the write lock while it works.
        (holder.of("items") as unknown as { $client: { exec: (sql: string) => void } }).$client.exec("BEGIN IMMEDIATE");

        try
        {
            waiting.migrate([{ plugin: "items", from: folder({ "0001-init.sql": CREATE }) }]);
            expect.unreachable();
        }
        catch (cause)
        {
            expect(cause).toBeInstanceOf(MigrationFault);
            expect((cause as MigrationFault).message).toMatch(/another process is migrating/i);
            // Nobody's fault but the clock's: naming a plugin here would send
            // its author looking at a file that is not the problem.
            expect((cause as MigrationFault).plugin).toBe("");
        }

        (holder.of("items") as unknown as { $client: { exec: (sql: string) => void } }).$client.exec("ROLLBACK");
        waiting.close();
        holder.close();
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
