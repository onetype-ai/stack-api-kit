import type { PGlite } from "@electric-sql/pglite";

let shared: Promise<PGlite> | undefined;

/**
 * The one PGlite database a test worker keeps under KIT_DIALECT=postgres. Starting it takes seconds, so every store a
 * worker's tests open borrows it, each in a schema of its own.
 */
export function sharedPglite(): Promise<PGlite>
{
    shared ??= import("@electric-sql/pglite").then(({ PGlite: Database }) => Database.create());

    return shared;
}
