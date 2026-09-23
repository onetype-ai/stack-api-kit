import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { singleConnection } from "../internal/pgConnections";
import { numbered, pgSql } from "../internal/pgSql";
import { sqliteSql } from "../internal/sql";

import type { Sql } from "../internal/sql";

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Opened = { sql: Sql; close: () => Promise<void> };

// the same contract, once a database the kit speaks
const databases: readonly [string, () => Promise<Opened>][] = [
    ["SQLite", () =>
    {
        const connection = new Database(":memory:");

        return Promise.resolve({
            sql: sqliteSql(connection),
            close: () =>
            {
                connection.close();

                return Promise.resolve();
            },
        });
    }],
    ["Postgres (PGlite)", async () =>
    {
        const database = await PGlite.create();
        const connections = singleConnection(database);

        return { sql: pgSql(connections, { queue: connections.turns.run }), close: () => connections.close() };
    }],
];

describe.each(databases)("the kit's own SQL on %s", (_name, open) =>
{
    // one database for the lot: starting PGlite takes seconds, and each test clears the one table it uses
    let opened: Opened;

    beforeAll(async () =>
    {
        opened = await open();
    }, 30_000);

    afterAll(async () =>
    {
        await opened.close();
    });

    const ready = async (): Promise<Sql> =>
    {
        await opened.sql.exec(`DROP TABLE IF EXISTS "rows"`);
        await opened.sql.exec(`CREATE TABLE "rows" ("id" TEXT PRIMARY KEY, "count" INTEGER NOT NULL DEFAULT 0)`);

        return opened.sql;
    };

    test("runs statements with parameters and answers rows and changes", async () =>
    {
        const sql = await ready();

        const written = await sql.run(`INSERT INTO "rows" ("id", "count") VALUES (?, ?), (?, ?)`, ["a", 1, "b", 2]);
        const rows = await sql.rows<{ id: string; count: number }>(`SELECT "id", "count" FROM "rows" WHERE "count" > ? ORDER BY "id"`, [0]);

        expect(written.changes).toBe(2);
        expect(rows.map((row) => [row.id, Number(row.count)])).toEqual([["a", 1], ["b", 2]]);
    });

    test("keeps a transaction's work when it returns, and none of it when it throws", async () =>
    {
        const sql = await ready();

        await sql.transaction(async (inside) =>
        {
            await inside.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["kept"]);
        });
        await expect(sql.transaction(async (inside) =>
        {
            await inside.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["gone"]);

            throw new Error("the work failed");
        })).rejects.toThrow("the work failed");

        expect(await sql.rows(`SELECT "id" FROM "rows"`)).toEqual([{ id: "kept" }]);
    });

    test("makes a transaction inside one a savepoint, whose failure the outer one survives", async () =>
    {
        const sql = await ready();

        await sql.transaction(async (inside) =>
        {
            await inside.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["outer"]);
            await inside.transaction(async (deeper) =>
            {
                await deeper.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["inner"]);

                throw new Error("the inner work failed");
            }).catch(() => undefined);
        });

        expect(await sql.rows(`SELECT "id" FROM "rows"`)).toEqual([{ id: "outer" }]);
    });

    test("never nests a transaction from another chain of calls: one rolls back, the other's work holds", async () =>
    {
        const sql = await ready();

        const failing = sql.transaction(async (inside) =>
        {
            await inside.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["gone"]);
            await wait(30);

            throw new Error("the first work failed");
        });

        await wait(10);

        const holding = sql.transaction(async (inside) =>
        {
            await inside.run(`INSERT INTO "rows" ("id") VALUES (?)`, ["kept"]);
        });

        await expect(failing).rejects.toThrow("the first work failed");
        await holding;

        expect(await sql.rows(`SELECT "id" FROM "rows"`)).toEqual([{ id: "kept" }]);
    });
});

test.each([
    [`SELECT * FROM "rows" WHERE "id" = ? AND "count" > ?`, `SELECT * FROM "rows" WHERE "id" = $1 AND "count" > $2`],
    [`UPDATE "rows" SET "heard" = COALESCE("heard", '[?]') WHERE "id" = ?`, `UPDATE "rows" SET "heard" = COALESCE("heard", '[?]') WHERE "id" = $1`],
    [`SELECT ?::text`, `SELECT $1::text`],
])("numbers the parameters of %s, never one inside a string", (written, expected) =>
{
    expect(numbered(written)).toBe(expected);
});
