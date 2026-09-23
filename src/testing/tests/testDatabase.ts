import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dialect } from "../../plugins/database/api";
import { sharedPglite } from "../pglite";

import type { StartOptions } from "../../plugins/mount/api";

let count = 0;

/**
 * What a suite hands `start({ database })` on the database this run tests: a SQLite file of its own, or a schema of
 * its own in the worker's PGlite. `named` gives the same one again, for a suite that stops a process and starts the
 * next on what it left.
 */
export async function testDatabase(named?: string): Promise<NonNullable<StartOptions["database"]>>
{
    count += 1;

    const key = named ?? `db_${String(process.pid)}_${String(count)}`;

    if (dialect() === "sqlite")
    {
        return { file: join(mkdtempSync(join(tmpdir(), `kit-${key}-`)), "app.db") };
    }

    return { dialect: "postgres", pglite: await sharedPglite(), schema: key };
}
