import type Database from "better-sqlite3";

import type { Schedule, Scheduled } from "../../kernel/api";

/**
 * Where later work waits, in the same database as the work that asked for it.
 *
 * A job claimed by one process is not claimed by another: `take` marks and
 * reads in one statement, so two processes beating at the same moment split
 * the work rather than doubling it.
 *
 * Its table is the kit's, not a plugin's, so no contract declares it.
 */
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

    // One statement, so the claim and the read cannot come apart: a second
    // process reaching the same row finds it already taken.
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
        keep: (_db: unknown, job: Scheduled) =>
        {
            insert.run(job.id, job.plugin, job.command, JSON.stringify(job.input), job.at, job.attempts);
        },

        take: (now: number, limit: number) =>
        {
            const rows = claim.all(now, now, limit) as {
                id: string;
                plugin: string;
                command: string;
                input: string;
                runAt: number;
                attempts: number;
            }[];

            return Promise.resolve(rows.map((row): Scheduled => ({
                id: row.id,
                plugin: row.plugin,
                command: row.command,
                input: JSON.parse(row.input) as unknown,
                at: row.runAt,
                attempts: row.attempts,
            })));
        },

        done: (id: string) =>
        {
            remove.run(id);

            return Promise.resolve();
        },

        failed: (id: string, at: number) =>
        {
            again.run(at, id);

            return Promise.resolve();
        },

        gaveUp: (id: string) =>
        {
            remove.run(id);

            return Promise.resolve();
        },
    };
}
