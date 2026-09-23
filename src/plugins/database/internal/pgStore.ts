import { AsyncLocalStorage } from "node:async_hooks";

import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { refuseOtherDialect } from "./dialect";
import { migrateOver } from "./migrate";
import { outboxOver } from "./outbox";
import { poolConnections, singleConnection } from "./pgConnections";
import { pgOn, pgSql } from "./pgSql";
import { scheduleOver } from "./schedule";
import { createScopeFilter } from "./scopeFilter";

import type { Outbox, Schedule, ScopeFilter } from "../../kernel/api";
import type { MigrationSource, MigrationStep } from "./migrate";
import type { PgClient, PgConnections } from "./pgConnections";
import type { Sql } from "./sql";
import type { TablesByName } from "./store";

/** Where the Postgres database is: a server's URL, or a PGlite database in the process (tests, a single process). */
export type PostgresOptions = { tables: Readonly<Record<string, TablesByName>> } & (
    { url: string; poolSize?: number }

    /** `schema`, when named, is where this store keeps its tables in a PGlite database others share; closing drops it and leaves the database open. */
    | { pglite: PGlite; schema?: string }
);

/** What a project holds after opening a Postgres database; the same shape as SQLite's store. */
export type PostgresStore = {
    forPlugin: (plugin: string) => unknown;
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>;
    write: <Result>(run: () => Promise<Result>) => Promise<Result>;
    inTransaction: () => boolean;
    migrate: (sources: readonly MigrationSource[]) => Promise<MigrationStep[]>;
    close: () => Promise<void>;
    outbox: (settings?: { leaseMs?: number }) => Outbox;
    schedule: (settings?: { leaseMs?: number }) => Schedule;
    createScopeFilter: () => ScopeFilter;
};

/**
 * Opens a Postgres database and holds one handle per plugin over it. A transaction holds one connection and a nested
 * one from the same chain of calls is a savepoint on it. On a pool, work outside a transaction takes any other
 * client, so no one's rollback undoes it. On PGlite, one connection like SQLite, it waits for the transaction to end.
 */
export async function postgres(settings: PostgresOptions): Promise<PostgresStore>
{
    refuseOtherDialect("postgres");

    const single = "pglite" in settings;

    // imported here, not at the top: a project on SQLite installs neither driver, and must still load the kit
    const drizzle = single
        ? (await import("drizzle-orm/pglite")).drizzle as (client: PGlite, config: { schema: TablesByName }) => unknown
        : (await import("drizzle-orm/node-postgres")).drizzle as (client: Pool | PoolClient, config: { schema: TablesByName }) => unknown;
    const connections: PgConnections & { turns?: { run: <Result>(run: () => Promise<Result>) => Promise<Result> } } = single ? singleConnection(settings.pglite) : await poolConnections(settings.url, settings.poolSize);
    const turns = connections.turns;
    const borrowed = "pglite" in settings ? settings.schema : undefined;

    if (borrowed !== undefined)
    {
        if (!/^[a-z_][a-z0-9_]*$/u.test(borrowed))
        {
            throw new TypeError(`database: schema "${borrowed}" is not a plain name. Use lowercase letters, digits and underscores.`);
        }

        await connections.any.exec(`CREATE SCHEMA IF NOT EXISTS "${borrowed}"; SET search_path TO "${borrowed}"`);
    }

    /** Which transaction the running code is inside, and the connection each open one holds. */
    const inside = new AsyncLocalStorage<number>();
    const live = new Map<number, PgClient>();

    let open = true;
    let counter = 0;

    const current = (): number | undefined =>
    {
        const turn = inside.getStore();

        return turn !== undefined && live.has(turn) ? turn : undefined;
    };

    const serialized = <Result,>(run: () => Promise<Result>): Promise<Result> =>
    {
        return turns === undefined || current() !== undefined ? run() : turns.run(run);
    };

    const handleOver = (client: Pool | PoolClient | PGlite, plugin: string): unknown =>
    {
        const schema = settings.tables[plugin];

        if (schema === undefined)
        {
            return undefined;
        }

        return (drizzle as (client: Pool | PoolClient | PGlite, config: { schema: TablesByName }) => unknown)(client, { schema });
    };

    const handles = new Map<string, unknown>();

    const forPlugin = (plugin: string): unknown =>
    {
        if (!open)
        {
            throw new Error(`"${plugin}" reached the database after it was closed.`);
        }

        if (settings.tables[plugin] === undefined)
        {
            throw new Error(`"${plugin}" asked for a database handle but declares no tables. Add them to its contract, or stop reaching for ctx.db.`);
        }

        const kept = handles.get(plugin) ?? handleOver(connections.drizzleAny(), plugin);

        handles.set(plugin, kept);

        return kept;
    };

    const inTx = async <Result,>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result> =>
    {
        const outer = current();

        counter += 1;

        const turn = counter;
        const within = async (client: PgClient, begin: string, commit: string, rollback: string): Promise<Result> =>
        {
            await client.exec(begin);
            live.set(turn, client);

            try
            {
                const result = await inside.run(turn, () => run(handleOver(connections.drizzleClient(client), plugin)));

                await client.exec(commit);

                return result;
            }
            catch (cause)
            {
                await client.exec(rollback).catch(() => undefined);

                throw cause;
            }
            finally
            {
                live.delete(turn);
            }
        };

        const held = outer === undefined ? undefined : live.get(outer);

        if (held !== undefined)
        {
            const name = `sp_${String(turn)}`;

            return within(held, `SAVEPOINT ${name}`, `RELEASE SAVEPOINT ${name}`, `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        }

        return connections.hold((client) => within(client, "BEGIN", "COMMIT", "ROLLBACK"));
    };

    const sql = pgSql(connections, {
        ...(turns === undefined ? {} : { queue: turns.run }),
        isInsideStoreTransaction: () => single && current() !== undefined,
    });

    // a transaction's own writes (an outbox row, a job) go on the connection it holds, so they commit with it
    const onHeld = (): Sql =>
    {
        const turn = current();
        const client = turn === undefined ? undefined : live.get(turn);

        return client === undefined ? sql : pgOn(client);
    };

    const around = { within: onHeld, ...(turns === undefined ? {} : { outside: serialized }) };

    return {
        forPlugin,
        tx: (plugin, run) => current() === undefined ? serialized(() => inTx(plugin, run)) : inTx(plugin, run),
        write: serialized,
        inTransaction: () => current() !== undefined,
        migrate: (sources) => migrateOver(sql, sources),
        close: async () =>
        {
            open = false;
            handles.clear();

            if (borrowed === undefined)
            {
                await connections.close();

                return;
            }

            await connections.any.exec(`DROP SCHEMA "${borrowed}" CASCADE; SET search_path TO public`);
        },
        outbox: (leasing = {}) => outboxOver(sql, leasing, around),
        schedule: (leasing = {}) => scheduleOver(sql, leasing, around),
        createScopeFilter: () => createScopeFilter(settings.tables),
    };
}
