import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

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

/** One PGlite database, in the process: a single connection, so a transaction holds it and the rest waits. */
export function singleConnection(database: PGlite): PgConnections & { turns: ReturnType<typeof queue> }
{
    const turns = queue();

    const client: PgClient = {
        query: async <Row,>(text: string, params: readonly SqlValue[] = []) =>
        {
            const answer = await database.query<Row>(text, [...params]);

            return { rows: answer.rows, changes: answer.affectedRows ?? 0 };
        },
        exec: async (script: string) =>
        {
            await database.exec(script);
        },
    };

    return {
        any: client,
        hold: (run) => run(client),
        drizzleClient: () => database,
        drizzleAny: () => database,
        close: () => database.close(),
        turns,
    };
}
