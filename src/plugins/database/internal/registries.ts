import type { RegistryStore, StoredEntry } from "../../kernel/api";

import { createTogether } from "./schedule";
import { serialized } from "./sql";

import type { Around, Sql } from "./sql";

type Row = { key: string; plugin: string; entry: string; version: number | string };

/** Both tables, as either dialect creates them. */
function tablesOf(sql: Sql): string
{
    const whole = sql.dialect === "postgres" ? "BIGINT" : "INTEGER";

    return `
        CREATE TABLE IF NOT EXISTS "kit_registry_entries" (
            "registry" TEXT NOT NULL,
            "scope" TEXT NOT NULL,
            "key" TEXT NOT NULL,
            "plugin" TEXT NOT NULL,
            "entry" TEXT NOT NULL,
            "version" ${whole} NOT NULL,
            PRIMARY KEY ("registry", "scope", "key")
        );
        CREATE TABLE IF NOT EXISTS "kit_registry_versions" (
            "registry" TEXT NOT NULL,
            "scope" TEXT NOT NULL,
            "version" ${whole} NOT NULL,
            PRIMARY KEY ("registry", "scope")
        );
    `;
}

function prepare(sql: Sql): Promise<void>
{
    if (sql.now === undefined)
    {
        return createTogether(sql, tablesOf(sql));
    }

    sql.now.exec(tablesOf(sql));

    return Promise.resolve();
}

function storedOf(row: Row): StoredEntry
{
    return { key: row.key, plugin: row.plugin, entry: JSON.parse(row.entry) as unknown, version: Number(row.version) };
}

/**
 * Bumps the version first: on Postgres that locks the scope's version row, so two changes to one scope take turns
 * and each reads the entry the other left.
 */
async function bump(inside: Sql, registry: string, scope: string): Promise<number>
{
    const [row] = await inside.rows<{ version: number | string }>(
        `INSERT INTO "kit_registry_versions" ("registry", "scope", "version") VALUES (?, ?, 1)
         ON CONFLICT ("registry", "scope") DO UPDATE SET "version" = "kit_registry_versions"."version" + 1
         RETURNING "version"`,
        [registry, scope],
    );

    return Number(row?.version ?? 1);
}

async function read(on: Sql, registry: string, scope: string, key: string): Promise<StoredEntry | undefined>
{
    const [row] = await on.rows<Row>(
        `SELECT "key", "plugin", "entry", "version" FROM "kit_registry_entries" WHERE "registry" = ? AND "scope" = ? AND "key" = ?`,
        [registry, scope, key],
    );

    return row === undefined ? undefined : storedOf(row);
}

/** Where tenant registries keep their entries, in the same database as the work that changes them. */
export function registriesOver(sql: Sql, around: Around = {}): RegistryStore
{
    const ready = prepare(sql);
    const within = around.within ?? (() => sql);
    const free = around.outside === undefined ? sql : serialized(sql, around.outside);

    ready.catch(() => undefined);

    return {
        list: async (registry, scope) =>
        {
            await ready;

            // the version first: entries read after it are as new or newer, and a frame the client applies again is the same entry
            const [held] = await free.rows<{ version: number | string }>(
                `SELECT "version" FROM "kit_registry_versions" WHERE "registry" = ? AND "scope" = ?`,
                [registry, scope],
            );
            const rows = await free.rows<Row>(
                `SELECT "key", "plugin", "entry", "version" FROM "kit_registry_entries" WHERE "registry" = ? AND "scope" = ? ORDER BY "key"`,
                [registry, scope],
            );

            return { version: Number(held?.version ?? 0), entries: rows.map(storedOf) };
        },

        get: async (registry, scope, key) =>
        {
            await ready;

            return read(free, registry, scope, key);
        },

        save: async (db, { registry, scope, key, plugin, entry }) =>
        {
            await ready;

            const inside = within(db);
            const version = await bump(inside, registry, scope);
            const before = await read(inside, registry, scope, key);

            await inside.run(
                `INSERT INTO "kit_registry_entries" ("registry", "scope", "key", "plugin", "entry", "version") VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT ("registry", "scope", "key") DO UPDATE SET "plugin" = excluded."plugin", "entry" = excluded."entry", "version" = excluded."version"`,
                [registry, scope, key, plugin, JSON.stringify(entry), version],
            );

            return { version, before };
        },

        remove: async (db, { registry, scope, key }) =>
        {
            await ready;

            const inside = within(db);
            const before = await read(inside, registry, scope, key);

            if (before === undefined)
            {
                return undefined;
            }

            const version = await bump(inside, registry, scope);

            await inside.run(`DELETE FROM "kit_registry_entries" WHERE "registry" = ? AND "scope" = ? AND "key" = ?`, [registry, scope, key]);

            return { version, before };
        },
    };
}
