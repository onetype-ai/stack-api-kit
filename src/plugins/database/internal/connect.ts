import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { KernelFault } from "../../kernel/api";

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

    const { version } = connection.prepare("SELECT sqlite_version() AS version").get() as { version: string };

    try
    {
        refuseOldSqlite(version);
    }
    catch (cause)
    {
        connection.close();

        throw cause;
    }

    if (opening.wal ?? !memory)
    {
        connection.pragma("journal_mode = WAL");
        connection.pragma("synchronous = NORMAL");
    }

    connection.pragma("foreign_keys = ON");
    connection.pragma(`busy_timeout = ${opening.busyMs ?? 5_000}`);

    return connection;
}

/** The oldest SQLite the kit runs on: `IS NOT DISTINCT FROM`, which the schedule relies on, arrived in 3.39. */
export function refuseOldSqlite(version: string): void
{
    const [major = 0, minor = 0] = version.split(".").map(Number);

    if (major < 3 || (major === 3 && minor < 39))
    {
        throw new KernelFault(
            "UNSUPPORTED_DATABASE",
            `database: SQLite ${version} is older than 3.39, which the kit's schedule needs. Install better-sqlite3 13 or later, which bundles a newer one.`,
            { plugin: "database" },
        );
    }
}
