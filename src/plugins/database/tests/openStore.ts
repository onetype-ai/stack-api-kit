import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdPglite, sharedPglite } from "../../../testing/pglite";
import { database, dialect, postgres } from "../api";

import type { TablesByName } from "../internal/store";

/** A store's shape, whichever database a suite runs on. */
export type OpenedStore = Awaited<ReturnType<typeof postgres>> | ReturnType<typeof database>;

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

    count += 1;

    // held while open, so a test kernel's recycling never closes the PGlite under it
    const letGo = holdPglite();
    const store = await postgres({ pglite: await sharedPglite(), schema: `store_${String(process.pid)}_${String(count)}`, tables });

    return { ...store, close: async () =>
    {
        await store.close();
        letGo();
    } };
}

/** A migrations folder holding the same SQL for both dialects, for a suite whose table needs nothing either lacks. */
export function migrationsOf(sql: string): string
{
    const from = mkdtempSync(join(tmpdir(), "kit-migrations-"));

    for (const which of ["sqlite", "postgres"])
    {
        mkdirSync(join(from, which));
        writeFileSync(join(from, which, "0001-create.sql"), sql);
    }

    return from;
}

