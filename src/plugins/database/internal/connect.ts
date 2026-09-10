import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

/** What opening a database needs to know. */
export type DatabaseOptions = {
    /** A path, or ":memory:" for one that lives as long as the process. */
    file: string;

    /** How long a writer waits for another to finish, in milliseconds. */
    busyMs?: number;

    /** Whether to keep the write-ahead log. Off for :memory:, which has none. */
    wal?: boolean;
};

/** Opens one connection, configured the way a server needs it. */
export function connect(opening: DatabaseOptions): Database.Database
{
    const memory = opening.file === ":memory:";

    if (!memory)
    {
        mkdirSync(dirname(opening.file), { recursive: true });
    }

    const connection = new Database(opening.file);

    if (opening.wal ?? !memory)
    {
        connection.pragma("journal_mode = WAL");
        connection.pragma("synchronous = NORMAL");
    }

    connection.pragma("foreign_keys = ON");
    connection.pragma(`busy_timeout = ${opening.busyMs ?? 5_000}`);

    return connection;
}
