import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** One finding, written as a sentence a person can act on. */
export type DialectFinding = {
    file: string;
    message: string;
};

/** What a SQLite-only call is replaced with, so the same query runs on Postgres. */
const PORTABLE: Readonly<Record<string, string>> = {
    get: "await the query and take its first row ([row] = await ...)",
    all: "await the query itself",
    run: "await the statement itself",
};

/** A drizzle call only the SQLite driver answers: no argument, which a Map's get or a command's run always has. */
const SQLITE_ONLY = /\.(get|all|run)\(\s*\)/gu;

const MIGRATION = /^(\d{4})[-_][a-z0-9][a-z0-9_-]*\.sql$/u;

function isFolder(path: string): boolean
{
    return existsSync(path) && statSync(path).isDirectory();
}

function sourcesOf(folder: string): string[]
{
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    {
        const path = join(folder, entry.name);

        if (entry.isDirectory())
        {
            return entry.name === "tests" ? [] : sourcesOf(path);
        }

        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
}

function pluginsOf(root: string): string[]
{
    return isFolder(root) ? readdirSync(root).filter((name) => isFolder(join(root, name))).sort() : [];
}

/**
 * Where one plugin's migrations for SQLite and for Postgres went apart: a numbered file in one folder and not the
 * other. Both are generated from the same tables, so a gap means one dialect was generated and the other forgotten.
 * A plugin keeping one folder of files, the layout before 9.0, runs on SQLite alone and is not reported.
 */
export function findMigrationDrift(root: string): DialectFinding[]
{
    const found: DialectFinding[] = [];

    for (const plugin of pluginsOf(root))
    {
        const migrations = join(root, plugin, "migrations");
        const sqlite = join(migrations, "sqlite");
        const postgres = join(migrations, "postgres");

        if (!isFolder(sqlite) && !isFolder(postgres))
        {
            continue;
        }

        const named = (folder: string): Set<string> => new Set(isFolder(folder) ? readdirSync(folder).filter((name) => MIGRATION.test(name)) : []);
        const inSqlite = named(sqlite);
        const inPostgres = named(postgres);

        for (const [has, lacks, from, to] of [[inSqlite, inPostgres, "sqlite", "postgres"], [inPostgres, inSqlite, "postgres", "sqlite"]] as const)
        {
            for (const name of [...has].sort())
            {
                if (!lacks.has(name))
                {
                    found.push({
                        file: relative(root, join(migrations, from, name)),
                        message: `${plugin}/migrations/${from}/${name} has no twin in ${to}. Generate the migrations of both dialects from the same tables, once a dialect, so each database gets the same step.`,
                    });
                }
            }
        }
    }

    return found;
}

/**
 * Where a query ends in `.get()`, `.all()` or `.run()`, which only the SQLite driver answers: the same code fails on
 * Postgres. Read per statement, and only where the statement reaches a `db`, so a Map's get or a command's run passes.
 */
export function findSqliteOnlyCalls(root: string): DialectFinding[]
{
    const found: DialectFinding[] = [];

    for (const plugin of pluginsOf(root))
    {
        for (const path of sourcesOf(join(root, plugin)))
        {
            const source = readFileSync(path, "utf8");

            for (const call of source.matchAll(SQLITE_ONLY))
            {
                const at = call.index;
                // a statement starts after a semicolon or a block's brace on its own line; an object literal's braces sit inside it
                const start = Math.max(source.lastIndexOf(";", at), source.lastIndexOf("{\n", at), source.lastIndexOf("}\n", at));
                const statement = source.slice(start + 1, at);

                if (!/\bdb\b/u.test(statement))
                {
                    continue;
                }

                const method = call[1] ?? "";
                const line = source.slice(0, at).split("\n").length;

                found.push({
                    file: relative(root, path),
                    message: `${relative(root, path)}:${String(line)} ends a query in .${method}(), which only SQLite answers, so it fails on Postgres. Instead, ${PORTABLE[method] ?? "await the query"}.`,
                });
            }
        }
    }

    return found;
}
