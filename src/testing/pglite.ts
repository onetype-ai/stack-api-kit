import type { PGlite } from "@electric-sql/pglite";

let shared: Promise<PGlite> | undefined;
let extensions: Readonly<Record<string, unknown>> = {};
let started: string | undefined;

/** The extensions the worker's PGlite starts with, as a project's Postgres server carries them; named before it starts. */
export function usePgliteExtensions(given: Readonly<Record<string, unknown>>): void
{
    const names = Object.keys(given).sort().join(", ");

    if (started !== undefined && started !== names)
    {
        throw new TypeError(`configureTestKernels named PGlite extensions ${names === "" ? "none" : names}, and this worker's PGlite already started with ${started === "" ? "none" : started}. Name them once, in a setup file every test file shares.`);
    }

    extensions = given;
}

/**
 * The one PGlite database a test worker keeps under KIT_DIALECT=postgres. Starting it takes seconds, so every store a
 * worker's tests open borrows it, each in a schema of its own. Each extension named is installed once, in public,
 * which every store's schema reads after its own, so a migration's CREATE EXTENSION IF NOT EXISTS finds it.
 */
export function sharedPglite(): Promise<PGlite>
{
    started ??= Object.keys(extensions).sort().join(", ");

    shared ??= import("@electric-sql/pglite").then(async ({ PGlite: Database }) =>
    {
        const database = (await Database.create({ extensions: extensions as Record<string, never> })) as unknown as PGlite;

        for (const name of Object.keys(extensions))
        {
            await database.exec(`CREATE EXTENSION IF NOT EXISTS "${name.replaceAll("\"", "\"\"")}" SCHEMA public`);
        }

        return database;
    });

    return shared;
}
