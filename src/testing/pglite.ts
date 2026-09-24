import type { PGlite } from "@electric-sql/pglite";

let shared: Promise<PGlite> | undefined;

/**
 * The one PGlite database a test worker keeps under KIT_DIALECT=postgres. Starting it takes seconds, so every store a
 * worker's tests open borrows it, each in a schema of its own. It carries `unaccent`, which a Postgres server ships
 * installed once in public, so a migration's CREATE EXTENSION IF NOT EXISTS finds it.
 */
export function sharedPglite(): Promise<PGlite>
{
    shared ??= Promise.all([import("@electric-sql/pglite"), import("@electric-sql/pglite/contrib/unaccent")])
        .then(async ([{ PGlite: Database }, { unaccent }]) =>
        {
            const database = await Database.create({ extensions: { unaccent } });

            // once, in public: an extension belongs to the database, and each kernel's schema reads public after its own
            await database.exec("CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public");

            return database;
        });

    return shared;
}
