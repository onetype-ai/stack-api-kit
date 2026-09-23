import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Schedule, QueuedJob } from "../../kernel/api";

import { serialized, sqliteSql } from "./sql";

import type { Around, Sql } from "./sql";

/** How long a claim holds without a renewal when nothing says otherwise. */
const LEASE_MS = 60_000;

/** A lease length, refused unless it is a whole number of milliseconds from a second to an hour. */
export function leaseOf(settings: { leaseMs?: number }): number
{
    const leaseMs = settings.leaseMs ?? LEASE_MS;

    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000)
    {
        throw new TypeError(`leaseMs ${String(leaseMs)} is not a whole number of milliseconds from 1000 to 3600000. Pass one, or leave it out for ${String(LEASE_MS)}.`);
    }

    return leaseMs;
}

/**
 * Where later work waits, in the same database as the work that asked for it.
 *
 * A claim is a lease: the process renews it while the command runs, and a lease nobody renewed
 * means the process died, so the job is taken again and the lost run counted. Only the holder of
 * a claim may finish or put back what it claimed.
 */
/** The table and its index, as either dialect creates them. */
function tableOf(sql: Sql): string
{
    const whole = sql.dialect === "postgres" ? "BIGINT" : "INTEGER";

    return `
        CREATE TABLE IF NOT EXISTS "kit_schedule" (
            "id" TEXT PRIMARY KEY,
            "plugin" TEXT NOT NULL,
            "command" TEXT NOT NULL,
            "input" TEXT NOT NULL,
            "runAt" ${whole} NOT NULL,
            "takenAt" ${whole},
            "takenBy" TEXT,
            "attempts" INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS "kit_schedule_due" ON "kit_schedule" ("runAt") WHERE "takenAt" IS NULL;
    `;
}

/**
 * Creates the table. On SQLite it is ready before the factory returns, as it always was, and a table written
 * before leases gains its holder column so its rows still read.
 */
function prepare(sql: Sql): Promise<void>
{
    if (sql.now === undefined)
    {
        return sql.exec(tableOf(sql));
    }

    sql.now.exec(tableOf(sql));

    const columns = sql.now.rows<{ name: string }>(`PRAGMA table_info("kit_schedule")`);

    if (!columns.some((column) => column.name === "takenBy"))
    {
        sql.now.exec(`ALTER TABLE "kit_schedule" ADD COLUMN "takenBy" TEXT`);
    }

    return Promise.resolve();
}

/**
 * Where later work waits, in the same database as the work that asked for it.
 *
 * A claim is a lease: the process renews it while the command runs, and a lease nobody renewed
 * means the process died, so the job is taken again and the lost run counted. Only the holder of
 * a claim may finish or put back what it claimed.
 *
 * `within` answers the statements a transaction's own handle runs, as for the outbox.
 */
export function scheduleOver(sql: Sql, settings: { leaseMs?: number } = {}, around: Around = {}): Schedule
{
    const leaseMs = leaseOf(settings);
    const ready = prepare(sql);
    const within = around.within ?? (() => sql);
    const free = around.outside === undefined ? sql : serialized(sql, around.outside);

    ready.catch(() => undefined);

    return {
        save: async (db: unknown, job: QueuedJob) =>
        {
            await ready;
            await within(db).run(
                `INSERT INTO "kit_schedule" ("id", "plugin", "command", "input", "runAt", "attempts") VALUES (?, ?, ?, ?, ?, ?)`,
                [job.id, job.plugin, job.command, JSON.stringify(job.input), job.at, job.attempts],
            );
        },

        leaseMs,

        // each claim is its own lease, so a run that outlived its lease cannot finish a job claimed again since, even in this process
        claim: async (now: number, limit: number) =>
        {
            await ready;

            const rows = await free.rows<{ id: string; plugin: string; command: string; input: string; runAt: number | string; attempts: number; takenBy: string }>(`
                UPDATE "kit_schedule"
                SET "takenAt" = ?, "takenBy" = ?, "attempts" = CASE WHEN "takenAt" IS NULL THEN "attempts" ELSE "attempts" + 1 END
                WHERE "id" IN (
                    SELECT "id" FROM "kit_schedule"
                    WHERE "runAt" <= ? AND ("takenAt" IS NULL OR "takenAt" < ?)
                    ORDER BY "runAt"
                    LIMIT ?
                )
                RETURNING "id", "plugin", "command", "input", "runAt", "attempts", "takenBy"
            `, [now, randomUUID(), now, now - leaseMs, limit]);

            return rows.map((row): QueuedJob => ({
                id: row.id,
                plugin: row.plugin,
                command: row.command,
                input: JSON.parse(row.input) as unknown,
                at: Number(row.runAt),
                attempts: Number(row.attempts),
                lease: row.takenBy,
            }));
        },

        counts: async (now: number) =>
        {
            await ready;

            const [row] = await free.rows<{ due: number | string | null; later: number | string | null; running: number | string | null; abandoned: number | string | null }>(`
                SELECT
                    SUM(CASE WHEN "takenAt" IS NULL AND "runAt" <= ? THEN 1 ELSE 0 END) AS "due",
                    SUM(CASE WHEN "takenAt" IS NULL AND "runAt" > ? THEN 1 ELSE 0 END) AS "later",
                    SUM(CASE WHEN "takenAt" IS NOT NULL AND "takenAt" >= ? THEN 1 ELSE 0 END) AS "running",
                    SUM(CASE WHEN "takenAt" IS NOT NULL AND "takenAt" < ? THEN 1 ELSE 0 END) AS "abandoned"
                FROM "kit_schedule"
            `, [now, now, now - leaseMs, now - leaseMs]);

            return { due: Number(row?.due ?? 0), later: Number(row?.later ?? 0), running: Number(row?.running ?? 0), abandoned: Number(row?.abandoned ?? 0) };
        },

        renew: async (id: string, now: number, lease?: string) =>
        {
            await ready;

            const { changes } = await free.run(`UPDATE "kit_schedule" SET "takenAt" = ? WHERE "id" = ? AND "takenBy" = ?`, [now, id, lease ?? null]);

            return changes > 0;
        },

        markDone: async (id: string, lease?: string) =>
        {
            await ready;
            await free.run(`DELETE FROM "kit_schedule" WHERE "id" = ? AND "takenBy" IS NOT DISTINCT FROM ?`, [id, lease ?? null]);
        },

        markFailed: async (id: string, at: number, lease?: string) =>
        {
            await ready;
            await free.run(
                `UPDATE "kit_schedule" SET "takenAt" = NULL, "takenBy" = NULL, "runAt" = ?, "attempts" = "attempts" + 1 WHERE "id" = ? AND "takenBy" IS NOT DISTINCT FROM ?`,
                [at, id, lease ?? null],
            );
        },

        giveUp: async (id: string, lease?: string) =>
        {
            await ready;
            await free.run(`DELETE FROM "kit_schedule" WHERE "id" = ? AND "takenBy" IS NOT DISTINCT FROM ?`, [id, lease ?? null]);
        },
    };
}

/** Where later work waits, in the same SQLite database as the work that asked for it. */
export function schedule(connection: Database.Database, settings: { leaseMs?: number } = {}): Schedule
{
    return scheduleOver(sqliteSql(connection), settings);
}
