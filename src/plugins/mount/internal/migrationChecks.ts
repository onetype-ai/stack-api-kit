import { migrationSteps } from "../../database/api";

import { tableIndexes } from "../../kernel/api";

import type { Plugin } from "../../kernel/api";

/**
 * A table or index name as a migration writes it: bare, "quoted", `backquoted` as drizzle-kit writes SQLite, or
 * [bracketed], after an optional schema such as "public". What is captured is the name alone.
 */
const NAME = String.raw`(?:[\`"\[]?[A-Za-z0-9_]+[\`"\]]?\.)?[\`"\[]?([A-Za-z0-9_]+)[\`"\]]?`;

/** One index a table declares that no migration creates. */
type UnmigratedIndex = {
    plugin: string;
    table: string;
    name: string;
    unique: boolean;
};

/** Declared indexes no migration creates. */
function missingIndexes(plugins: readonly Plugin[], sources: readonly { plugin: string; from: string }[]): UnmigratedIndex[]
{
    const declared: UnmigratedIndex[] = [];

    for (const plugin of plugins)
    {
        for (const [key, table] of Object.entries(plugin.definition.tables ?? {}))
        {
            for (const index of tableIndexes(table))
            {
                declared.push({ plugin: plugin.name, table: key, name: index.name, unique: index.unique });
            }
        }
    }

    if (declared.length === 0)
    {
        return [];
    }

    let sql = "";

    for (const source of sources)
    {
        for (const step of migrationSteps(source))
        {
            sql += `${step.sql}\n`;
        }
    }

    const created = new Set(
        [...sql.matchAll(new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "gi"))]
            .map((found) => found[1] ?? ""),
    );

    return declared.filter((table) => !created.has(table.name));
}


/** The name a drizzle table carries into SQL, or "" where it cannot be read. */
function tableName(table: unknown): string
{
    if (table === null || typeof table !== "object")
    {
        return "";
    }

    const key = Object.getOwnPropertySymbols(table).find((symbol) => symbol.description === "drizzle:Name");
    const name = key === undefined ? undefined : (table as Record<symbol, unknown>)[key];

    return typeof name === "string" ? name : "";
}


/** Declared tables no migration creates. */
function missingTables(plugins: readonly Plugin[], sources: readonly { plugin: string; from: string }[]): { plugin: string; table: string; name: string }[]
{
    const declared: { plugin: string; table: string; name: string }[] = [];

    for (const plugin of plugins)
    {
        for (const [key, table] of Object.entries(plugin.definition.tables ?? {}))
        {
            const inDatabase = tableName(table);

            if (inDatabase !== "")
            {
                declared.push({ plugin: plugin.name, table: key, name: inDatabase });
            }
        }
    }

    if (declared.length === 0)
    {
        return [];
    }

    let sql = "";

    for (const source of sources)
    {
        for (const step of migrationSteps(source))
        {
            sql += `${step.sql}\n`;
        }
    }

    const created = new Set(
        [...sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "gi"))]
            .map((found) => found[1] ?? ""),
    );

    return declared.filter((table) => !created.has(table.name));
}


/** One migration reaching a table another plugin owns, undeclared. */
type UndeclaredRead = {
    plugin: string;
    table: string;
    owner: string;
};

/** Migrations reading a table another plugin owns without depending on it. */
function undeclaredReads(plugins: readonly Plugin[], sources: readonly { plugin: string; from: string }[]): UndeclaredRead[]
{
    const sqlOf = new Map<string, string>();

    for (const source of sources)
    {
        let sql = "";

        for (const step of migrationSteps(source))
        {
            sql += `${step.sql}\n`;
        }

        sqlOf.set(source.plugin, sql);
    }

    const owner = new Map<string, string>();

    for (const [plugin, sql] of sqlOf)
    {
        for (const found of sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "gi")))
        {
            owner.set((found[1] ?? "").toLowerCase(), plugin);
        }
    }

    const declared = new Map(plugins.map((plugin) => [plugin.name, new Set(plugin.definition.dependsOn ?? [])]));
    const crossings: UndeclaredRead[] = [];
    const seen = new Set<string>();

    for (const [plugin, sql] of sqlOf)
    {
        for (const found of sql.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+${NAME}`, "gi")))
        {
            const table = (found[1] ?? "").toLowerCase();
            const owns = owner.get(table);

            if (owns === undefined || owns === plugin || declared.get(plugin)?.has(owns) === true)
            {
                continue;
            }

            const key = `${plugin}/${table}`;

            if (!seen.has(key))
            {
                seen.add(key);
                crossings.push({ plugin, table, owner: owns });
            }
        }
    }

    return crossings;
}

/**
 * Refuses, before anything runs, declared tables or indexes no migration creates and migrations reading another
 * plugin's table without depending on it: start runs this, and so does a test kernel, so a test cannot pass where a
 * real start would refuse.
 */
export function refuseUnmigrated(plugins: readonly Plugin[], migrations: readonly { plugin: string; from: string }[]): void
{
    const uncreated = missingTables(plugins, migrations);

    if (uncreated.length > 0)
    {
        throw new TypeError(
            `${uncreated.length} declared ${uncreated.length === 1 ? "table is" : "tables are"} in no migration, so ${uncreated.length === 1 ? "it never reaches" : "they never reach"} the database:\n${uncreated.map((table) => `  - ${table.plugin}: "${table.table}" is declared as "${table.name}" and nothing creates it. The first query answers a table that is not there. Add CREATE TABLE ${table.name} to a migration, or drop the declaration.`).join("\n")}`,
        );
    }

    const unmigrated = missingIndexes(plugins, migrations);

    if (unmigrated.length > 0)
    {
        throw new TypeError(
            `${unmigrated.length} declared ${unmigrated.length === 1 ? "index is" : "indexes are"} in no migration, so ${unmigrated.length === 1 ? "it never reaches" : "they never reach"} the database:\n${unmigrated.map((index) => `  - ${index.plugin}: ${index.unique ? "uniqueIndex" : "index"} "${index.name}" on "${index.table}". A uniqueIndex nothing created accepts the duplicate it was declared to stop. Add CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} to a migration, or drop the declaration.`).join("\n")}`,
        );
    }

    const crossings = undeclaredReads(plugins, migrations);

    if (crossings.length > 0)
    {
        throw new TypeError(
            `${crossings.length} ${crossings.length === 1 ? "migration reaches a table" : "migrations reach tables"} another plugin owns without depending on it:\n${crossings.map((crossing) => `  - ${crossing.plugin}: reads "${crossing.table}", which "${crossing.owner}" creates. It works only while names happen to sort that way, and refuses the day either is renamed. Add "${crossing.owner}" to dependsOn, or stop reading its table.`).join("\n")}`,
        );
    }
}
