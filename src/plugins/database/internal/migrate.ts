import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { KernelFault } from "../../kernel/api";

import { dialect } from "./dialect";

import type { Dialect } from "./dialect";
import type { Sql } from "./sql";

import { unqualified } from "./unqualified";

/** Where one plugin keeps its migrations. */
export type MigrationSource = {
    plugin: string;
    from: string;
};

/** One migration file, as it sits on disk. */
export type MigrationStep = {
    plugin: string;
    name: string;
    sql: string;
    hash: string;
};

/** What went wrong, in a sentence naming the file. */
export class MigrationFault extends Error
{
    readonly plugin: string;

    readonly step: string | undefined;

    constructor(message: string, plugin: string, step?: string)
    {
        super(message);

        this.name = "MigrationFault";
        this.plugin = plugin;
        this.step = step;
    }
}

// `NNNN-name.sql`, or `NNNN_name.sql` as drizzle-kit generates it
const NUMBERED = /^(\d{4})[-_][a-z0-9][a-z0-9_-]*\.sql$/;

/** The table recording what has run. Ours, and no plugin's to read. */
const LEDGER = `
    CREATE TABLE IF NOT EXISTS "_migrations" (
        "plugin" TEXT NOT NULL,
        "name"   TEXT NOT NULL,
        "hash"   TEXT NOT NULL,
        "ran_at" TEXT NOT NULL,
        PRIMARY KEY ("plugin", "name")
    )
`;

/** What a file says, hashed so a later edit to it is visible. */
function read(plugin: string, from: string, name: string): MigrationStep
{
    const sql = readFileSync(join(from, name), "utf8");

    return { plugin, name, sql, hash: createHash("sha256").update(sql).digest("hex") };
}

/** Whether a path is a folder. */
function isFolder(path: string): boolean
{
    return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Where one plugin keeps the migrations of a dialect: `<from>/sqlite` and `<from>/postgres`, each generated from the
 * same table definitions. A folder holding the files itself is the layout before 9.0, which is SQLite's alone.
 */
function folderFor(source: MigrationSource, which: Dialect): string
{
    const own = join(source.from, which);
    const other = which === "sqlite" ? "postgres" : "sqlite";

    if (isFolder(own))
    {
        return own;
    }

    if (isFolder(join(source.from, other)))
    {
        throw new MigrationFault(`"${source.plugin}" keeps migrations for ${other} in ${join(source.from, other)} and none for ${which}. Generate them into ${own} from the same table definitions.`, source.plugin);
    }

    const flat = isFolder(source.from) && readdirSync(source.from).some((name) => name.endsWith(".sql"));

    if (which === "postgres" && flat)
    {
        throw new MigrationFault(`"${source.plugin}" keeps its migrations in ${source.from} itself, the SQLite-only layout. Move them into ${join(source.from, "sqlite")} and generate ${join(source.from, "postgres")} from the same table definitions.`, source.plugin);
    }

    return source.from;
}

/** The migrations one plugin holds for a dialect, the process's own unless named, in the order their numbers give. */
export function migrationSteps(source: MigrationSource, which: Dialect = dialect()): MigrationStep[]
{
    let names: string[];
    const folder = folderFor(source, which);

    try
    {
        names = readdirSync(folder);
    }
    catch
    {
        throw new MigrationFault(`"${source.plugin}" declares migrations at "${source.from}", which cannot be read.`, source.plugin);
    }

    const sql = names.filter((name) => name.endsWith(".sql"));

    for (const name of sql)
    {
        if (!NUMBERED.test(name))
        {
            throw new MigrationFault(`"${name}" is not named NNNN-name.sql (or drizzle-kit's NNNN_name.sql), so its place in the order is ambiguous.`, source.plugin, name);
        }
    }

    const numbers = new Map<string, string>();

    for (const name of sql)
    {
        const numbered = NUMBERED.exec(name)?.[1] ?? "";
        const claimed = numbers.get(numbered);

        if (claimed !== undefined)
        {
            throw new MigrationFault(`"${name}" and "${claimed}" share the number ${numbered}, so which runs first is undefined.`, source.plugin, name);
        }

        numbers.set(numbered, name);
    }

    return [...sql].sort().map((name) => read(source.plugin, folder, name));
}

/**
 * Runs what has not run yet, in dependency order, all in one transaction, which on SQLite holds the write lock.
 * `check` runs inside it after the last step, so what it refuses rolls every step back.
 */
export async function migrateOver(sql: Sql, sources: readonly MigrationSource[], check: (inside: Sql) => void | Promise<void> = () => undefined): Promise<MigrationStep[]>
{
    let began = false;

    try
    {
        return await sql.transaction(async (inside) =>
        {
            began = true;

            const applied = await applyMigrations(inside, sources);

            await check(inside);

            return applied;
        }, "store.migrate");
    }
    catch (cause)
    {
        if (began || cause instanceof KernelFault)
        {
            throw cause;
        }

        throw new MigrationFault(
            `Another process is migrating this database and holds the write lock: ${cause instanceof Error ? cause.message : String(cause)}. Migrations run once, under one lock, so this boot did not start. Let the other finish, or raise busyMs if migrating takes longer than it allows.`,
            "",
        );
    }
}

/** Refuses a migration that left a table nothing can write to. */
export function refuseUnwritable(connection: Database.Database, tables: readonly string[]): void
{
    for (const table of tables)
    {
        const columns = connection.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as { name: string }[];

        if (columns.length === 0)
        {
            continue;
        }

        const quotedColumns = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
        const marks = columns.map(() => "?").join(", ");

        try
        {
            connection.prepare(`INSERT INTO "${table.replaceAll('"', '""')}" (${quotedColumns}) VALUES (${marks})`);
        }
        catch (cause)
        {
            throw new MigrationFault(
                `Table "${table}" was created but nothing can write to it: ${cause instanceof Error ? cause.message : String(cause)}. A migration that leaves a table unwritable passes and then fails every insert, so this boot stopped instead.`,
                "",
            );
        }
    }
}

/** What migrate does once it holds the lock. Its failure rolls the lot back. */
/** A key every process migrating one Postgres database takes, so two boots migrate one after the other. */
const MIGRATING = 7_239_104_217;

async function applyMigrations(sql: Sql, sources: readonly MigrationSource[]): Promise<MigrationStep[]>
{
    if (sql.dialect === "postgres")
    {
        await sql.rows(`SELECT pg_advisory_xact_lock(?)`, [MIGRATING]);
    }

    await sql.exec(LEDGER);

    const applied = new Map<string, string>();

    for (const row of await sql.rows<{ plugin: string; name: string; hash: string }>(`SELECT "plugin", "name", "hash" FROM "_migrations"`))
    {
        applied.set(`${row.plugin}/${row.name}`, row.hash);
    }

    const steps: MigrationStep[] = [];

    for (const source of sources)
    {
        for (const step of migrationSteps(source, sql.dialect))
        {
            const before = applied.get(`${step.plugin}/${step.name}`);

            if (before === step.hash)
            {
                continue;
            }

            if (before !== undefined)
            {
                throw new MigrationFault(
                    `"${step.name}" has changed since it ran. A migration is history: add a new one rather than editing what other databases already applied.`,
                    step.plugin,
                    step.name,
                );
            }

            try
            {
                // the ledger keeps the hash of the file as written; only what runs loses drizzle-kit's schema prefix
                await sql.exec(sql.dialect === "postgres" ? unqualified(step.sql) : step.sql);
                await sql.run(`INSERT INTO "_migrations" ("plugin", "name", "hash", "ran_at") VALUES (?, ?, ?, ?)`, [step.plugin, step.name, step.hash, new Date().toISOString()]);
            }
            catch (cause)
            {
                throw new MigrationFault(
                    `"${step.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    step.plugin,
                    step.name,
                );
            }

            steps.push(step);
        }
    }

    return steps;
}
