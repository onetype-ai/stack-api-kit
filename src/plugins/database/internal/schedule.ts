import type Database from "better-sqlite3";

import type { Schedule, QueuedJob } from "../../kernel/api";

/** Where later work waits, in the same database as the work that asked for it. */
export function schedule(connection: Database.Database): Schedule
{
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

    const insert = connection.prepare(
        "INSERT INTO kit_schedule (id, plugin, command, input, runAt, attempts) VALUES (?, ?, ?, ?, ?, ?)",
    );

    const claim = connection.prepare(`
        UPDATE kit_schedule SET takenAt = ?
        WHERE id IN (
            SELECT id FROM kit_schedule
            WHERE takenAt IS NULL AND runAt <= ?
            ORDER BY runAt
            LIMIT ?
        )
        RETURNING id, plugin, command, input, runAt, attempts
    `);

    const remove = connection.prepare("DELETE FROM kit_schedule WHERE id = ?");
    const again = connection.prepare(
        "UPDATE kit_schedule SET takenAt = NULL, runAt = ?, attempts = attempts + 1 WHERE id = ?",
    );

    return {
        save: (_db: unknown, job: QueuedJob) =>
        {
            insert.run(job.id, job.plugin, job.command, JSON.stringify(job.input), job.at, job.attempts);
        },

        claim: (now: number, limit: number) =>
        {
            const rows = claim.all(now, now, limit) as {
                id: string;
                plugin: string;
                command: string;
                input: string;
                runAt: number;
                attempts: number;
            }[];

            return Promise.resolve(rows.map((row): QueuedJob => ({
                id: row.id,
                plugin: row.plugin,
                command: row.command,
                input: JSON.parse(row.input) as unknown,
                at: row.runAt,
                attempts: row.attempts,
            })));
        },

        markDone: (id: string) =>
        {
            remove.run(id);

            return Promise.resolve();
        },

        markFailed: (id: string, at: number) =>
        {
            again.run(at, id);

            return Promise.resolve();
        },

        giveUp: (id: string) =>
        {
            remove.run(id);

            return Promise.resolve();
        },
    };
}
