import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

/** Where one plugin keeps its migrations. */
export type Source = {
    plugin: string;
    from: string;
};

/** One migration file, as it sits on disk. */
export type Step = {
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

const NAMED = /^(\d{4})-[a-z0-9][a-z0-9-]*\.sql$/;

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
function read(plugin: string, from: string, name: string): Step
{
    const sql = readFileSync(join(from, name), "utf8");

    return { plugin, name, sql, hash: createHash("sha256").update(sql).digest("hex") };
}

/**
 * The migrations one plugin holds, in the order their numbers give.
 *
 * A name outside `NNNN-name.sql` is refused rather than sorted somewhere:
 * "2-b.sql" sorts before "10-a.sql" as text and after it as a number, and a
 * schema that depends on which is a schema nobody can reproduce.
 */
export function migrationSteps(source: Source): Step[]
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
        if (!NAMED.test(name))
        {
            throw new MigrationFault(`"${name}" is not named NNNN-name.sql, so its place in the order is ambiguous.`, source.plugin, name);
        }
    }

    const numbers = new Map<string, string>();

    for (const name of sql)
    {
        const at = NAMED.exec(name)?.[1] ?? "";
        const first = numbers.get(at);

        if (first !== undefined)
        {
            throw new MigrationFault(`"${name}" and "${first}" share the number ${at}, so which runs first is undefined.`, source.plugin, name);
        }

        numbers.set(at, name);
    }

    return [...sql].sort().map((name) => read(source.plugin, source.from, name));
}

/**
 * Runs what has not run yet, in dependency order, all under one write lock.
 *
 * A migration already recorded is checked against what it recorded rather
 * than skipped quietly: a file edited after it ran leaves one database with
 * the old shape and another with the new, both reporting they are current.
 *
 * The lock is taken before the ledger is read, and everything runs inside it:
 *
 * - Two processes booting together otherwise both read an empty ledger and
 *   the second fails on "table already exists", which names neither the race
 *   nor a way out. Under the lock the second waits, then reads a full ledger
 *   and has nothing to do.
 * - A failure half way otherwise leaves the earlier files applied AND
 *   recorded, so the author cannot correct them: the hash guard answers "has
 *   changed since it ran". Rolled back, the database is as it was and every
 *   file is still the author's to fix.
 *
 * Rolling all of them back costs nothing that is running, because nothing is:
 * a boot that cannot migrate does not start.
 */
export function migrate(connection: Database.Database, sources: readonly Source[], tables: readonly string[] = []): Step[] {
    // IMMEDIATE rather than DEFERRED: a deferred transaction takes the write
    // lock at the first write, which is after the ledger has been read, and
    // the read is the half that has to be inside it.
    try
    {
        connection.exec("BEGIN IMMEDIATE");
    }
    catch (cause)
    {
        // Said rather than passed on: SQLite answers "database is locked",
        // which names neither what is holding it nor that waiting was already
        // tried. A boot stopping here is a boot that waited its whole
        // busy_timeout for another one to finish migrating.
        throw new MigrationFault(
            `Another process is migrating this database and holds the write lock: ${cause instanceof Error ? cause.message : String(cause)}. Migrations run once, under one lock, so this boot did not start. Let the other finish, or raise busyMs if migrating takes longer than it allows.`,
            // No plugin is at fault here: the lock is the database's, and the
            // one holding it belongs to another process entirely.
            "",
        );
    }

    try
    {
        const ran = apply(connection, sources);

        refuseUnwritable(connection, tables);

        connection.exec("COMMIT");

        return ran;
    }
    catch (cause)
    {
        connection.exec("ROLLBACK");

        throw cause;
    }
}

/**
 * Refuses a migration that left a table nothing can write to.
 *
 * SQLite accepts `CHECK (n > 0 OR RAISE(ABORT, 'why'))` at CREATE and only
 * refuses at the first write, so the migration passes, the ledger records it,
 * and every insert into that table fails afterwards, the valid rows with the
 * rest. `RAISE` belongs in a trigger; a plain `CHECK` names the constraint.
 *
 * Compiling an insert is what proves it, rather than reading the SQL: the
 * shape of a broken constraint is not something a pattern can be trusted to
 * recognise, and a statement that will not compile is exactly the failure.
 * Nothing is written, and only tables a plugin declared are tried, so a
 * virtual table's shadow tables are never touched.
 */
function refuseUnwritable(connection: Database.Database, tables: readonly string[]): void
{
    for (const table of tables)
    {
        const columns = connection.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as { name: string }[];

        if (columns.length === 0)
        {
            continue;
        }

        const named = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
        const marks = columns.map(() => "?").join(", ");

        try
        {
            connection.prepare(`INSERT INTO "${table.replaceAll('"', '""')}" (${named}) VALUES (${marks})`);
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
function apply(connection: Database.Database, sources: readonly Source[]): Step[]
{
    connection.exec(LEDGER);

    const applied = new Map<string, string>();

    for (const row of connection.prepare("SELECT plugin, name, hash FROM _migrations").all() as { plugin: string; name: string; hash: string }[])
    {
        applied.set(`${row.plugin}/${row.name}`, row.hash);
    }

    const steps: Step[] = [];

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
