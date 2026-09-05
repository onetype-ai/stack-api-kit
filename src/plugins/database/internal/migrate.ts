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
    let found: string[];

    try
    {
        found = readdirSync(source.from);
    }
    catch
    {
        throw new MigrationFault(`"${source.plugin}" declares migrations at "${source.from}", which cannot be read.`, source.plugin);
    }

    const sql = found.filter((name) => name.endsWith(".sql"));

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
 * Runs what has not run yet, in dependency order, each in its own transaction.
 *
 * A migration already recorded is checked against what it recorded rather
 * than skipped quietly: a file edited after it ran leaves one database with
 * the old shape and another with the new, both reporting they are current.
 */
export function migrate(connection: Database.Database, sources: readonly Source[]): Step[] {
    connection.exec(LEDGER);

    const seen = new Map<string, string>();

    for (const row of connection.prepare("SELECT plugin, name, hash FROM _migrations").all() as { plugin: string; name: string; hash: string }[])
    {
        seen.set(`${row.plugin}/${row.name}`, row.hash);
    }

    const ran: Step[] = [];

    for (const source of sources)
    {
        for (const step of migrationSteps(source))
        {
            const before = seen.get(`${step.plugin}/${step.name}`);

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

            // One transaction per step, so a failure leaves the ones before it
            // applied and recorded rather than half of one applied.
            const apply = connection.transaction(() =>
            {
                connection.exec(step.sql);
                connection.prepare("INSERT INTO _migrations (plugin, name, hash, ran_at) VALUES (?, ?, ?, ?)")
                    .run(step.plugin, step.name, step.hash, new Date().toISOString());
            });

            try
            {
                apply();
            }
            catch (cause)
            {
                throw new MigrationFault(
                    `"${step.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    step.plugin,
                    step.name,
                );
            }

            ran.push(step);
        }
    }

    return ran;
}
