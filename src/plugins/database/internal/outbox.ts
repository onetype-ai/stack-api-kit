import type Database from "better-sqlite3";

import type { Announcement, Outbox } from "../../kernel/api";

/**
 * Where events wait, in the same database as the work they announce.
 *
 * That is the whole point: the row is written by the transaction that emitted
 * the event, so the two cannot disagree. An event about work that rolled back
 * rolls back with it, and work that committed leaves an event behind even if
 * the process stops before anyone hears it.
 *
 * Its table is the kit's, not a plugin's, so no contract declares it and no
 * `ctx.db` reaches it.
 */
export function outbox(connection: Database.Database): Outbox
{
    connection.exec(`
        CREATE TABLE IF NOT EXISTS kit_outbox (
            id TEXT PRIMARY KEY,
            plugin TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            keptAt TEXT NOT NULL
        )
    `);

    const insert = connection.prepare(
        "INSERT INTO kit_outbox (id, plugin, name, payload, keptAt) VALUES (?, ?, ?, ?, ?)",
    );

    const remove = connection.prepare("DELETE FROM kit_outbox WHERE id = ?");
    const unsent = connection.prepare("SELECT id, plugin, name, payload FROM kit_outbox ORDER BY keptAt");

    return {
        // Synchronous, and it must stay that way: this runs inside an open
        // transaction, and an await here would let another one interleave.
        keep: (_db: unknown, announcements: readonly Announcement[]) =>
        {
            const at = new Date().toISOString();

            for (const one of announcements)
            {
                insert.run(one.id, one.plugin, one.name, JSON.stringify(one.payload), at);
            }
        },

        sent: (id: string) =>
        {
            // A delivery can finish after the process began stopping, and
            // this runs when it does. Forgetting a delivered event matters
            // less than crashing on the way out: the event is delivered
            // either way, and what stays is redelivered next start, which
            // at-least-once already allows for.
            try
            {
                remove.run(id);
            }
            catch (cause)
            {
                if (!(cause instanceof TypeError))
                {
                    throw cause;
                }
            }

            return Promise.resolve();
        },

        waiting: () =>
        {
            const rows = unsent.all() as { id: string; plugin: string; name: string; payload: string }[];

            return Promise.resolve(rows.map((row): Announcement => ({
                id: row.id,
                plugin: row.plugin,
                name: row.name,
                payload: JSON.parse(row.payload) as unknown,
            })));
        },
    };
}
