import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Schedule, QueuedJob } from "../../kernel/api";

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
export function schedule(connection: Database.Database, settings: { leaseMs?: number } = {}): Schedule
{
    const leaseMs = leaseOf(settings);

    connection.exec(`
        CREATE TABLE IF NOT EXISTS kit_schedule (
            id TEXT PRIMARY KEY,
            plugin TEXT NOT NULL,
            command TEXT NOT NULL,
            input TEXT NOT NULL,
            runAt INTEGER NOT NULL,
            takenAt INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS kit_schedule_due ON kit_schedule (runAt) WHERE takenAt IS NULL;
    `);

    // a table written before leases carries no holder: added, so its rows still read
    const columns = connection.prepare("PRAGMA table_info(kit_schedule)").all() as { name: string }[];

    if (!columns.some((column) => column.name === "takenBy"))
    {
        connection.exec("ALTER TABLE kit_schedule ADD COLUMN takenBy TEXT");
    }

    const insert = connection.prepare(
        "INSERT INTO kit_schedule (id, plugin, command, input, runAt, attempts) VALUES (?, ?, ?, ?, ?, ?)",
    );

    const claim = connection.prepare(`
        UPDATE kit_schedule
        SET takenAt = ?, takenBy = ?, attempts = CASE WHEN takenAt IS NULL THEN attempts ELSE attempts + 1 END
        WHERE id IN (
            SELECT id FROM kit_schedule
            WHERE runAt <= ? AND (takenAt IS NULL OR takenAt < ?)
            ORDER BY runAt
            LIMIT ?
        )
        RETURNING id, plugin, command, input, runAt, attempts, takenBy
    `);

    const renew = connection.prepare("UPDATE kit_schedule SET takenAt = ? WHERE id = ? AND takenBy = ?");

    const countJobs = connection.prepare(`
        SELECT
            SUM(CASE WHEN takenAt IS NULL AND runAt <= ? THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN takenAt IS NULL AND runAt > ? THEN 1 ELSE 0 END) AS later,
            SUM(CASE WHEN takenAt IS NOT NULL AND takenAt >= ? THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN takenAt IS NOT NULL AND takenAt < ? THEN 1 ELSE 0 END) AS abandoned
        FROM kit_schedule
    `);
    const remove = connection.prepare("DELETE FROM kit_schedule WHERE id = ? AND takenBy IS ?");
    const again = connection.prepare(
        "UPDATE kit_schedule SET takenAt = NULL, takenBy = NULL, runAt = ?, attempts = attempts + 1 WHERE id = ? AND takenBy IS ?",
    );

    return {
        save: (_db: unknown, job: QueuedJob) =>
        {
            insert.run(job.id, job.plugin, job.command, JSON.stringify(job.input), job.at, job.attempts);
        },

        leaseMs,

        // each claim is its own lease, so a run that outlived its lease cannot finish a job claimed again since, even in this process
        claim: (now: number, limit: number) =>
        {
            const rows = claim.all(now, randomUUID(), now, now - leaseMs, limit) as {
                id: string;
                plugin: string;
                command: string;
                input: string;
                runAt: number;
                attempts: number;
                takenBy: string;
            }[];

            return Promise.resolve(rows.map((row): QueuedJob => ({
                id: row.id,
                plugin: row.plugin,
                command: row.command,
                input: JSON.parse(row.input) as unknown,
                at: row.runAt,
                attempts: row.attempts,
                lease: row.takenBy,
            })));
        },

        counts: (now: number) =>
        {
            const row = countJobs.get(now, now, now - leaseMs, now - leaseMs) as { due: number | null; later: number | null; running: number | null; abandoned: number | null };

            return Promise.resolve({ due: row.due ?? 0, later: row.later ?? 0, running: row.running ?? 0, abandoned: row.abandoned ?? 0 });
        },

        renew: (id: string, now: number, lease?: string) =>
        {
            return Promise.resolve(renew.run(now, id, lease ?? null).changes > 0);
        },

        markDone: (id: string, lease?: string) =>
        {
            remove.run(id, lease ?? null);

            return Promise.resolve();
        },

        markFailed: (id: string, at: number, lease?: string) =>
        {
            again.run(at, id, lease ?? null);

            return Promise.resolve();
        },

        giveUp: (id: string, lease?: string) =>
        {
            remove.run(id, lease ?? null);

            return Promise.resolve();
        },
    };
}
