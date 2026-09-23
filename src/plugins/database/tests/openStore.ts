import { PGlite } from "@electric-sql/pglite";

import { database, dialect, postgres } from "../api";

import type { TablesByName } from "../internal/store";

/** A store's shape, whichever database a suite runs on. */
export type OpenedStore = Awaited<ReturnType<typeof postgres>> | ReturnType<typeof database>;

let shared: Promise<PGlite> | undefined;
let count = 0;

/**
 * A fresh store on the database this run tests: SQLite in memory, or a schema of its own in the one PGlite database
 * this worker keeps, since starting PGlite takes seconds.
 */
export async function openStore(tables: Readonly<Record<string, TablesByName>>): Promise<OpenedStore>
{
    if (dialect() === "sqlite")
    {
        return database({ file: ":memory:", tables });
    }

    shared ??= PGlite.create();
    count += 1;

    return postgres({ pglite: await shared, schema: `store_${String(count)}`, tables });
}
