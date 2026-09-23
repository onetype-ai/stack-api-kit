import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { FailedEvent, OutboxMessage, Outbox } from "../../kernel/api";

import { createTogether, leaseOf, lockingOf } from "./schedule";
import { serialized, sqliteSql } from "./sql";

import type { Around, Sql } from "./sql";

type Row = { id: string; plugin: string; name: string; payload: string; heard: string | null; attempts: number };

/** The listeners a row says heard it. */
function heardOf(text: string | null | undefined): string[]
{
    return text === null || text === undefined ? [] : JSON.parse(text) as string[];
}

/** The table, as either dialect creates it. */
function tableOf(sql: Sql): string
{
    const whole = sql.dialect === "postgres" ? "BIGINT" : "INTEGER";

    return `
        CREATE TABLE IF NOT EXISTS "kit_outbox" (
            "id" TEXT PRIMARY KEY,
            "plugin" TEXT NOT NULL,
            "name" TEXT NOT NULL,
            "payload" TEXT NOT NULL,
            "writtenAt" TEXT NOT NULL,
            "heard" TEXT,
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "retryAt" ${whole},
            "takenAt" ${whole},
            "takenBy" TEXT,
            "failedAt" ${whole}
        )
    `;
}

/**
 * Creates the table. On SQLite it is ready before the factory returns, as it always was, and a table written by an
 * earlier release is brought up to date so its rows still read: the old column name, and the redelivery columns.
 */
function prepare(sql: Sql): Promise<void>
{
    if (sql.now === undefined)
    {
        return createTogether(sql, tableOf(sql));
    }

    sql.now.exec(tableOf(sql));

    const columns = sql.now.rows<{ name: string }>(`PRAGMA table_info("kit_outbox")`);

    if (columns.some((column) => column.name === "keptAt"))
    {
        sql.now.exec(`ALTER TABLE "kit_outbox" RENAME COLUMN "keptAt" TO "writtenAt"`);
    }

    const names = new Set(columns.map((column) => column.name));

    for (const [column, type] of [["heard", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["retryAt", "INTEGER"], ["takenAt", "INTEGER"], ["takenBy", "TEXT"], ["failedAt", "INTEGER"]] as const)
    {
        if (!names.has(column))
        {
            sql.now.exec(`ALTER TABLE "kit_outbox" ADD COLUMN "${column}" ${type}`);
        }
    }

    return Promise.resolve();
}

/** Adds one listener to the row's `heard` in a single statement, so two deliveries never overwrite each other. */
function addHeardStatement(sql: Sql): string
{
    return sql.dialect === "postgres"
        ? `UPDATE "kit_outbox" SET "heard" = (COALESCE("heard", '[]')::jsonb || to_jsonb(?::text))::text
           WHERE "id" = ? AND "takenBy" = ? AND NOT jsonb_exists(COALESCE("heard", '[]')::jsonb, ?)`
        : `UPDATE "kit_outbox" SET "heard" = json_insert(COALESCE("heard", '[]'), '$[#]', ?)
           WHERE "id" = ? AND "takenBy" = ? AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE("heard", '[]')) WHERE "value" = ?)`;
}

/**
 * Where events wait, in the same database as the work they announce. The process writing a row holds it for
 * `leaseMs` while it delivers; a row one listener refused waits out a backoff and is claimed again, by this process
 * or another, for the listeners that have not heard it.
 *
 * `within` answers the statements a transaction's own handle runs, where the database needs the transaction's
 * connection rather than any from the pool; SQLite has one connection and answers `sql` itself.
 */
export function outboxOver(sql: Sql, settings: { leaseMs?: number } = {}, around: Around = {}): Outbox
{
    const holder = randomUUID();
    const leaseMs = leaseOf(settings);
    const ready = prepare(sql);
    const within = around.within ?? (() => sql);
    const free = around.outside === undefined ? sql : serialized(sql, around.outside);

    ready.catch(() => undefined);

    return {
        // the writing process holds the row while it delivers, and nobody else takes it before its lease runs out
        save: async (db: unknown, messages: readonly OutboxMessage[]) =>
        {
            await ready;

            const now = Date.now();
            const writtenAt = new Date(now).toISOString();
            const inside = within(db);

            for (const announcement of messages)
            {
                await inside.run(
                    `INSERT INTO "kit_outbox" ("id", "plugin", "name", "payload", "writtenAt", "retryAt", "takenAt", "takenBy") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [announcement.id, announcement.plugin, announcement.name, JSON.stringify(announcement.payload), writtenAt, now + leaseMs, now, holder],
                );
            }
        },

        markSent: async (id: string) =>
        {
            await ready;

            // A failure, a closed connection during shutdown included, rejects rather than being swallowed:
            // a row wrongly taken as sent is an event lost, and one left behind is only delivered again.
            await free.run(`DELETE FROM "kit_outbox" WHERE "id" = ?`, [id]);
        },

        pending: async () =>
        {
            await ready;

            const rows = await free.rows<{ id: string; plugin: string; name: string; payload: string }>(
                `SELECT "id", "plugin", "name", "payload" FROM "kit_outbox" WHERE "failedAt" IS NULL ORDER BY "writtenAt"`,
            );

            return rows.map((row): OutboxMessage => ({
                id: row.id,
                plugin: row.plugin,
                name: row.name,
                payload: JSON.parse(row.payload) as unknown,
            }));
        },

        leaseMs,

        claim: async (now: number, limit: number) =>
        {
            await ready;

            const rows = await free.rows<Row>(`
                UPDATE "kit_outbox" SET "takenAt" = ?, "takenBy" = ?
                WHERE "id" IN (
                    SELECT "id" FROM "kit_outbox"
                    WHERE "failedAt" IS NULL AND ("retryAt" IS NULL OR "retryAt" <= ?) AND ("takenAt" IS NULL OR "takenAt" < ?)
                    ORDER BY "writtenAt"
                    LIMIT ?${lockingOf(sql)}
                )
                AND "failedAt" IS NULL AND ("retryAt" IS NULL OR "retryAt" <= ?) AND ("takenAt" IS NULL OR "takenAt" < ?)
                RETURNING "id", "plugin", "name", "payload", "heard", "attempts"
            `, [now, holder, now, now - leaseMs, limit, now, now - leaseMs]);

            return rows.map((row) => ({
                id: row.id,
                plugin: row.plugin,
                name: row.name,
                payload: JSON.parse(row.payload) as unknown,
                heard: heardOf(row.heard),
                attempts: Number(row.attempts),
            }));
        },

        renew: async (id: string, now: number) =>
        {
            await ready;

            const { changes } = await free.run(`UPDATE "kit_outbox" SET "takenAt" = ? WHERE "id" = ? AND "takenBy" = ?`, [now, id, holder]);

            return changes > 0;
        },

        markHeard: async (id: string, listener: string) =>
        {
            await ready;
            await free.run(addHeardStatement(sql), [listener, id, holder, listener]);
        },

        markRetry: async (id: string, heard: readonly string[], attempts: number, at: number) =>
        {
            await ready;
            await free.run(
                `UPDATE "kit_outbox" SET "heard" = ?, "attempts" = ?, "retryAt" = ?, "takenAt" = NULL, "takenBy" = NULL WHERE "id" = ? AND ("takenBy" IS NULL OR "takenBy" = ?)`,
                [JSON.stringify(heard), attempts, at, id, holder],
            );
        },

        markDead: async (id: string, heard: readonly string[], attempts: number, at: number) =>
        {
            await ready;
            await free.run(
                `UPDATE "kit_outbox" SET "heard" = ?, "attempts" = ?, "failedAt" = ?, "takenAt" = NULL, "takenBy" = NULL WHERE "id" = ? AND ("takenBy" IS NULL OR "takenBy" = ?)`,
                [JSON.stringify(heard), attempts, at, id, holder],
            );
        },

        failed: async () =>
        {
            await ready;

            const rows = await free.rows<{ id: string; plugin: string; name: string; heard: string | null; attempts: number; failedAt: number }>(
                `SELECT "id", "plugin", "name", "heard", "attempts", "failedAt" FROM "kit_outbox" WHERE "failedAt" IS NOT NULL ORDER BY "failedAt"`,
            );

            return rows.map((row): FailedEvent => ({ id: row.id, plugin: row.plugin, name: row.name, heard: heardOf(row.heard), attempts: Number(row.attempts), failedAt: Number(row.failedAt) }));
        },

        counts: async () =>
        {
            await ready;

            const [row] = await free.rows<{ waiting: number | string | null; retrying: number | string | null; dead: number | string | null }>(`
                SELECT
                    SUM(CASE WHEN "failedAt" IS NULL AND "attempts" = 0 THEN 1 ELSE 0 END) AS "waiting",
                    SUM(CASE WHEN "failedAt" IS NULL AND "attempts" > 0 THEN 1 ELSE 0 END) AS "retrying",
                    SUM(CASE WHEN "failedAt" IS NOT NULL THEN 1 ELSE 0 END) AS "dead"
                FROM "kit_outbox"
            `);

            return { waiting: Number(row?.waiting ?? 0), retrying: Number(row?.retrying ?? 0), dead: Number(row?.dead ?? 0) };
        },

        revive: async (id: string, now: number) =>
        {
            await ready;

            const { changes } = await free.run(`UPDATE "kit_outbox" SET "failedAt" = NULL, "attempts" = 0, "retryAt" = ? WHERE "id" = ? AND "failedAt" IS NOT NULL`, [now, id]);

            return changes > 0;
        },
    };
}

/**
 * Where events wait, in the same SQLite database as the work they announce. The process writing a row holds it for
 * `leaseMs` while it delivers; a row one listener refused waits out a backoff and is claimed again, by this process
 * or another, for the listeners that have not heard it.
 */
export function outbox(connection: Database.Database, settings: { leaseMs?: number } = {}): Outbox
{
    return outboxOver(sqliteSql(connection), settings);
}
