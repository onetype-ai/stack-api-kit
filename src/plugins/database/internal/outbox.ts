import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { FailedEvent, OutboxMessage, Outbox } from "../../kernel/api";

import { leaseOf } from "./schedule";

type Row = { id: string; plugin: string; name: string; payload: string; heard: string | null; attempts: number };

/** The listeners a row says heard it. */
function heardOf(text: string | null | undefined): string[]
{
    return text === null || text === undefined ? [] : JSON.parse(text) as string[];
}

/**
 * Where events wait, in the same database as the work they announce. The process writing a row holds it for
 * `leaseMs` while it delivers; a row one listener refused waits out a backoff and is claimed again, by this process
 * or another, for the listeners that have not heard it.
 */
export function outbox(connection: Database.Database, settings: { leaseMs?: number } = {}): Outbox
{
    const holder = randomUUID();
    const leaseMs = leaseOf(settings);

    connection.exec(`
        CREATE TABLE IF NOT EXISTS kit_outbox (
            id TEXT PRIMARY KEY,
            plugin TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            writtenAt TEXT NOT NULL
        )
    `);

    /* A table written before the column was renamed still carries the old one. */
    const columns = connection.prepare("PRAGMA table_info(kit_outbox)").all() as { name: string }[];

    if (columns.some((column) => column.name === "keptAt"))
    {
        connection.exec("ALTER TABLE kit_outbox RENAME COLUMN keptAt TO writtenAt");
    }

    // a table written before redelivery lacks these: added, so its rows still read
    const names = new Set((connection.prepare("PRAGMA table_info(kit_outbox)").all() as { name: string }[]).map((column) => column.name));

    for (const [column, type] of [["heard", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["retryAt", "INTEGER"], ["takenAt", "INTEGER"], ["takenBy", "TEXT"], ["failedAt", "INTEGER"]] as const)
    {
        if (!names.has(column))
        {
            connection.exec(`ALTER TABLE kit_outbox ADD COLUMN ${column} ${type}`);
        }
    }

    const insert = connection.prepare(
        "INSERT INTO kit_outbox (id, plugin, name, payload, writtenAt, retryAt, takenAt, takenBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    const remove = connection.prepare("DELETE FROM kit_outbox WHERE id = ?");
    const selectUnsent = connection.prepare("SELECT id, plugin, name, payload FROM kit_outbox WHERE failedAt IS NULL ORDER BY writtenAt");
    const renewRow = connection.prepare("UPDATE kit_outbox SET takenAt = ? WHERE id = ? AND takenBy = ?");
    const heardRow = connection.prepare("SELECT heard FROM kit_outbox WHERE id = ? AND takenBy = ?");
    const writeHeard = connection.prepare("UPDATE kit_outbox SET heard = ? WHERE id = ? AND takenBy = ?");

    const addHeard = connection.transaction((id: string, listener: string) =>
    {
        const row = heardRow.get(id, holder) as { heard: string | null } | undefined;

        if (row === undefined)
        {
            return;
        }

        const heard = heardOf(row.heard);

        if (!heard.includes(listener))
        {
            writeHeard.run(JSON.stringify([...heard, listener]), id, holder);
        }
    });

    const claim = connection.prepare(`
        UPDATE kit_outbox SET takenAt = ?, takenBy = ?
        WHERE id IN (
            SELECT id FROM kit_outbox
            WHERE failedAt IS NULL AND (retryAt IS NULL OR retryAt <= ?) AND (takenAt IS NULL OR takenAt < ?)
            ORDER BY writtenAt
            LIMIT ?
        )
        RETURNING id, plugin, name, payload, heard, attempts
    `);

    const retry = connection.prepare(
        "UPDATE kit_outbox SET heard = ?, attempts = ?, retryAt = ?, takenAt = NULL, takenBy = NULL WHERE id = ? AND (takenBy IS NULL OR takenBy = ?)",
    );

    const dead = connection.prepare(
        "UPDATE kit_outbox SET heard = ?, attempts = ?, failedAt = ?, takenAt = NULL, takenBy = NULL WHERE id = ? AND (takenBy IS NULL OR takenBy = ?)",
    );

    const selectFailed = connection.prepare("SELECT id, plugin, name, heard, attempts, failedAt FROM kit_outbox WHERE failedAt IS NOT NULL ORDER BY failedAt");
    const countRows = connection.prepare(`
        SELECT
            SUM(CASE WHEN failedAt IS NULL AND attempts = 0 THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN failedAt IS NULL AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
            SUM(CASE WHEN failedAt IS NOT NULL THEN 1 ELSE 0 END) AS dead
        FROM kit_outbox
    `);

    const revive = connection.prepare("UPDATE kit_outbox SET failedAt = NULL, attempts = 0, retryAt = ? WHERE id = ? AND failedAt IS NOT NULL");

    return {
        // the writing process holds the row while it delivers, and nobody else takes it before its lease runs out
        save: (_db: unknown, messages: readonly OutboxMessage[]) =>
        {
            const now = Date.now();
            const writtenAt = new Date(now).toISOString();

            for (const announcement of messages)
            {
                insert.run(announcement.id, announcement.plugin, announcement.name, JSON.stringify(announcement.payload), writtenAt, now + leaseMs, now, holder);
            }
        },

        markSent: (id: string) =>
        {
            try
            {
                remove.run(id);
            }
            catch (cause)
            {
                // A closed connection is the one case worth surviving: shutdown
                // races a delivery in flight. Swallowing every TypeError hid
                // that, and the row stayed for start() to deliver twice.
                const closed = cause instanceof TypeError && /connection is not open/iu.test(cause.message);

                if (!closed)
                {
                    throw cause;
                }

                return Promise.reject(cause);
            }

            return Promise.resolve();
        },

        pending: () =>
        {
            const rows = selectUnsent.all() as { id: string; plugin: string; name: string; payload: string }[];

            return Promise.resolve(rows.map((row): OutboxMessage => ({
                id: row.id,
                plugin: row.plugin,
                name: row.name,
                payload: JSON.parse(row.payload) as unknown,
            })));
        },

        leaseMs,

        claim: (now: number, limit: number) =>
        {
            const rows = claim.all(now, holder, now, now - leaseMs, limit) as Row[];

            return Promise.resolve(rows.map((row) => ({
                id: row.id,
                plugin: row.plugin,
                name: row.name,
                payload: JSON.parse(row.payload) as unknown,
                heard: heardOf(row.heard),
                attempts: row.attempts,
            })));
        },

        renew: (id: string, now: number) =>
        {
            return Promise.resolve(renewRow.run(now, id, holder).changes > 0);
        },

        markHeard: (id: string, listener: string) =>
        {
            addHeard(id, listener);

            return Promise.resolve();
        },

        markRetry: (id: string, heard: readonly string[], attempts: number, at: number) =>
        {
            retry.run(JSON.stringify(heard), attempts, at, id, holder);

            return Promise.resolve();
        },

        markDead: (id: string, heard: readonly string[], attempts: number, at: number) =>
        {
            dead.run(JSON.stringify(heard), attempts, at, id, holder);

            return Promise.resolve();
        },

        failed: () =>
        {
            const rows = selectFailed.all() as { id: string; plugin: string; name: string; heard: string | null; attempts: number; failedAt: number }[];

            return Promise.resolve(rows.map((row): FailedEvent => ({ id: row.id, plugin: row.plugin, name: row.name, heard: heardOf(row.heard), attempts: row.attempts, failedAt: row.failedAt })));
        },

        counts: () =>
        {
            const row = countRows.get() as { waiting: number | null; retrying: number | null; dead: number | null };

            return Promise.resolve({ waiting: row.waiting ?? 0, retrying: row.retrying ?? 0, dead: row.dead ?? 0 });
        },

        revive: (id: string, now: number) =>
        {
            return Promise.resolve(revive.run(now, id).changes > 0);
        },
    };
}
