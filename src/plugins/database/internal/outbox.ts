import type Database from "better-sqlite3";

import type { OutboxMessage, Outbox } from "../../kernel/api";

/** Where events wait, in the same database as the work they announce. */
export function outbox(connection: Database.Database): Outbox
{
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

    const insert = connection.prepare(
        "INSERT INTO kit_outbox (id, plugin, name, payload, writtenAt) VALUES (?, ?, ?, ?, ?)",
    );

    const remove = connection.prepare("DELETE FROM kit_outbox WHERE id = ?");
    const selectUnsent = connection.prepare("SELECT id, plugin, name, payload FROM kit_outbox ORDER BY writtenAt");

    return {
        save: (_db: unknown, messages: readonly OutboxMessage[]) =>
        {
            const keptAt = new Date().toISOString();

            for (const announcement of messages)
            {
                insert.run(announcement.id, announcement.plugin, announcement.name, JSON.stringify(announcement.payload), keptAt);
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
                if (!(cause instanceof TypeError))
                {
                    throw cause;
                }
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
    };
}
