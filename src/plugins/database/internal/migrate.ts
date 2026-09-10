import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

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

const NUMBERED = /^(\d{4})-[a-z0-9][a-z0-9-]*\.sql$/;

/** The table recording what has run. Ours, and no plugin's to read. */
const LEDGER = `
    CREATE TABLE IF NOT EXISTS _migrations (
        plugin TEXT NOT NULL,
        name   TEXT NOT NULL,
        hash   TEXT NOT NULL,
        ran_at TEXT NOT NULL,
        PRIMARY KEY (plugin, name)
    )
`;

/** What a file says, hashed so a later edit to it is visible. */
function read(plugin: string, from: string, name: string): MigrationStep
{
    const sql = readFileSync(join(from, name), "utf8");

    return { plugin, name, sql, hash: createHash("sha256").update(sql).digest("hex") };
}

/** The migrations one plugin holds, in the order their numbers give. */
export function migrationSteps(source: MigrationSource): MigrationStep[]
{
    let names: string[];

    try
    {
        names = readdirSync(source.from);
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
            throw new MigrationFault(`"${name}" is not named NNNN-name.sql, so its place in the order is ambiguous.`, source.plugin, name);
        }
    }

    const numbers = new Map<string, string>();

    for (const name of sql)
    {
        const numbered = NUMBERED.exec(name)?.[1] ?? "";
        const first = numbers.get(numbered);

        if (first !== undefined)
        {
            throw new MigrationFault(`"${name}" and "${first}" share the number ${numbered}, so which runs first is undefined.`, source.plugin, name);
        }

        numbers.set(numbered, name);
    }

    return [...sql].sort().map((name) => read(source.plugin, source.from, name));
}

/** Runs what has not run yet, in dependency order, all under one write lock. */
export function migrate(connection: Database.Database, sources: readonly MigrationSource[], tables: readonly string[] = []): MigrationStep[] {
    try
    {
        connection.exec("BEGIN IMMEDIATE");
    }
    catch (cause)
    {
        throw new MigrationFault(
            `Another process is migrating this database and holds the write lock: ${cause instanceof Error ? cause.message : String(cause)}. Migrations run once, under one lock, so this boot did not start. Let the other finish, or raise busyMs if migrating takes longer than it allows.`,
            "",
        );
    }

    try
    {
        const applied = applyMigrations(connection, sources);

        refuseUnwritable(connection, tables);

        connection.exec("COMMIT");

        return applied;
    }
    catch (cause)
    {
        connection.exec("ROLLBACK");

        throw cause;
    }
}

/** Refuses a migration that left a table nothing can write to. */
function refuseUnwritable(connection: Database.Database, tables: readonly string[]): void
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
function applyMigrations(connection: Database.Database, sources: readonly MigrationSource[]): MigrationStep[]
{
    connection.exec(LEDGER);

    const applied = new Map<string, string>();

    for (const row of connection.prepare("SELECT plugin, name, hash FROM _migrations").all() as { plugin: string; name: string; hash: string }[])
    {
        applied.set(`${row.plugin}/${row.name}`, row.hash);
    }

    const steps: MigrationStep[] = [];

    for (const source of sources)
    {
        for (const step of migrationSteps(source))
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
                connection.exec(step.sql);
                connection.prepare("INSERT INTO _migrations (plugin, name, hash, ran_at) VALUES (?, ?, ?, ?)")
                    .run(step.plugin, step.name, step.hash, new Date().toISOString());
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
