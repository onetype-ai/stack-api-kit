import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AsyncLocalStorage } from "node:async_hooks";

import { queue } from "./queue";

import type { Logger } from "../../kernel/api";

import type { SqlValue } from "./sql";

/** One Postgres connection, as the kit's own SQL speaks to it: `$n` parameters, and a script with none. */
export type PgClient = {
    query: <Row>(text: string, params?: readonly SqlValue[]) => Promise<{ rows: Row[]; changes: number }>;
    exec: (script: string) => Promise<void>;

    /** Marks a held connection as no longer fit to reuse: a ROLLBACK that failed, a socket that died. */
    ruin?: (cause: unknown) => void;
};

/**
 * Where Postgres statements go. `any` runs one outside a transaction; `hold` keeps one connection for a transaction
 * while it runs. A pool hands each transaction a client of its own, so nothing outside it lands inside it. PGlite is
 * one connection, like SQLite: a transaction holds it, and everything else waits its turn.
 */
export type PgConnections = {
    any: PgClient;
    hold: <Result>(run: (client: PgClient) => Promise<Result>) => Promise<Result>;

    /** The connection a transaction holds, handed to drizzle for a plugin's handle. */
    drizzleClient: (client: PgClient) => Pool | PoolClient | PGlite;

    /** The same for work outside a transaction. */
    drizzleAny: () => Pool | PGlite;

    close: () => Promise<void>;
};

const HELD = Symbol("held connection");

/** The kit's client over node-postgres, remembering the driver's own so drizzle can be handed it. */
function overPg(client: Pool | PoolClient): PgClient
{
    const wrapped: PgClient & { [HELD]?: Pool | PoolClient } = {
        query: async <Row,>(text: string, params: readonly SqlValue[] = []) =>
        {
            const answer = await client.query(text, [...params]);

            return { rows: answer.rows as Row[], changes: answer.rowCount ?? 0 };
        },
        exec: async (script: string) =>
        {
            await client.query(script);
        },
    };

    wrapped[HELD] = client;

    return wrapped;
}

/**
 * A pool of connections to a Postgres server. An idle connection the server drops (a restart, a failover) is logged
 * and replaced rather than taking the process down, and a connection a transaction left unfit is destroyed, never
 * handed to the next one. Nothing here writes the URL, which carries the password.
 */
export async function poolConnections(url: string, size = 10, log?: Logger): Promise<PgConnections>
{
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: size });

    pool.on("error", (cause: Error) =>
    {
        log?.error("database: an idle Postgres connection failed; the pool drops it and opens another", { cause: cause.message });
    });

    return {
        any: overPg(pool),
        hold: async (run) =>
        {
            const client = await pool.connect();
            let unfit: unknown;
            const held = overPg(client);

            held.ruin = (cause) =>
            {
                unfit = cause;
            };

            // a held client whose server dropped it emits 'error', which the pool listens for only while it is idle
            const dropped = (cause: Error): void =>
            {
                unfit = cause;
                log?.error("database: a Postgres connection held by a transaction failed; it is dropped, not reused", { cause: cause.message });
            };

            client.on("error", dropped);

            try
            {
                return await run(held);
            }
            finally
            {
                client.off("error", dropped);

                // `true` or an Error destroys the client: one left inside an aborted transaction answers every next query with an error
                client.release(unfit === undefined ? undefined : unfit instanceof Error ? unfit : true);
            }
        },
        drizzleClient: (client) => (client as { [HELD]?: Pool | PoolClient })[HELD] ?? pool,
        drizzleAny: () => pool,
        close: () => pool.end(),
    };
}

/** Each PGlite's one line of turns, shared by every store borrowing it, and whether the running code holds one. */
const lines = new WeakMap<PGlite, { turns: ReturnType<typeof queue>; holding: AsyncLocalStorage<{ isActive: boolean }> }>();

/** The line of turns every store on this PGlite waits in. */
function lineOf(database: PGlite): { turns: ReturnType<typeof queue>; holding: AsyncLocalStorage<{ isActive: boolean }> }
{
    const existing = lines.get(database);

    if (existing !== undefined)
    {
        return existing;
    }

    const made = { turns: queue(), holding: new AsyncLocalStorage<{ isActive: boolean }>() };

    lines.set(database, made);

    return made;
}

/**
 * Runs work alone on a PGlite that several stores may share: one connection, so a transaction another store left
 * open would take in this work, and its rollback would undo it. Work inside a turn still running runs as it is; work
 * a finished turn left behind, as a promise outliving it, waits in line like any other.
 */
export function exclusively<Result>(database: PGlite, work: () => Promise<Result>): Promise<Result>
{
    const { turns, holding } = lineOf(database);

    if (holding.getStore()?.isActive === true)
    {
        return work();
    }

    return turns.run(async () =>
    {
        const turn = { isActive: true };

        try
        {
            return await holding.run(turn, work);
        }
        finally
        {
            turn.isActive = false;
        }
    });
}

/**
 * One PGlite database, in the process: a single connection. Every store borrowing it waits in one line of turns, a
 * transaction holding the turn until it ends, and each turn first points the connection at its own store's schema,
 * since search_path belongs to the connection and another store may have moved it.
 */
export function singleConnection(database: PGlite, schema?: string): PgConnections & { turns: { run: <Result>(run: () => Promise<Result>) => Promise<Result> } }
{
    const pointed = schema === undefined ? undefined : `SET search_path TO "${schema}", public`;

    const turns = {
        run: <Result,>(work: () => Promise<Result>): Promise<Result> =>
        {
            return exclusively(database, async () =>
            {
                if (pointed !== undefined)
                {
                    await database.exec(pointed);
                }

                return work();
            });
        },
    };

    const client: PgClient = {
        query: <Row,>(text: string, params: readonly SqlValue[] = []) => turns.run(async () =>
        {
            const answer = await database.query<Row>(text, [...params]);

            return { rows: answer.rows, changes: answer.affectedRows ?? 0 };
        }),
        exec: (script: string) => turns.run(async () =>
        {
            await database.exec(script);
        }),
    };

    // what a plugin's handle runs takes a turn too, its own transactions included: PGlite's transaction is a BEGIN on
    // the one connection, and another store's turn inside it would move its schema and share its rollback
    const unheld = new Proxy(database, {
        get: (target, property, receiver) =>
        {
            const value: unknown = Reflect.get(target, property, receiver);

            if ((property === "query" || property === "exec" || property === "transaction" || property === "sql") && typeof value === "function")
            {
                return (...args: unknown[]) => turns.run(() => (value as (...given: unknown[]) => Promise<unknown>).apply(target, args));
            }

            return typeof value === "function" ? (value as (...given: unknown[]) => unknown).bind(target) : value;
        },
    });

    return {
        any: client,
        hold: (run) => turns.run(() => run(client)),
        drizzleClient: () => unheld,
        drizzleAny: () => unheld,
        close: () => database.close(),
        turns,
    };
}
