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

/**
 * Opens one connection, configured the way a server needs it.
 *
 * SQLite defaults suit a single-process script, not a server, and every one
 * of these was chosen rather than inherited:
 *
 * - WAL lets readers work while one writer writes. Without it a read blocks
 *   every write, and a busy server spends its afternoon waiting.
 * - foreign_keys is OFF by default, which means a schema declaring them gets
 *   no enforcement at all and nobody is told.
 * - busy_timeout turns "database is locked", thrown instantly, into a wait.
 *   SQLite has one writer; the question is only whether the second one waits
 *   or fails.
 * - NORMAL synchronous is the pairing WAL is designed for: durable across a
 *   process crash, and only at risk in an OS-level power loss.
 */
export function connect(opening: DatabaseOptions): Database.Database
{
    const memory = opening.file === ":memory:";

    // Made rather than demanded: better-sqlite3 answers an absent directory
    // with "Cannot open database because the directory does not exist",
    // naming neither the path nor the setting, so the first run of a fresh
    // checkout fails on something nobody chose.
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
