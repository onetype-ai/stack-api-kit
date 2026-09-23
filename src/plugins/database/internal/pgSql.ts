import { AsyncLocalStorage } from "node:async_hooks";

import { KernelFault } from "../../kernel/api";

import type { PgClient, PgConnections } from "./pgConnections";
import type { Sql, SqlValue } from "./sql";

/** A statement written with `?` for each parameter, as Postgres wants it: `$1`, `$2`, and none counted inside a quoted string. */
export function numbered(text: string): string
{
    let count = 0;
    let quoted = false;
    let written = "";

    for (const character of text)
    {
        if (character === "'")
        {
            quoted = !quoted;
        }

        if (character === "?" && !quoted)
        {
            count += 1;
            written += `$${String(count)}`;
        }
        else
        {
            written += character;
        }
    }

    return written;
}

type Held = { client: PgClient; depth: number };

export type PgSqlOptions = {
    /** Where a transaction waits for the one before it; left out, it opens at once, as a pool's own client allows. */
    queue?: <Result>(run: () => Promise<Result>) => Promise<Result>;

    /** Whether the running code is inside a transaction the store opened, on a connection this one shares. */
    isInsideStoreTransaction?: () => boolean;
};

/**
 * The kit's own SQL over Postgres. Statements outside a transaction go to `any`, never to a connection a transaction
 * holds, so no one's rollback undoes them. A transaction holds one connection; one inside it, from the same chain of
 * calls, is a savepoint on that connection.
 */
export function pgSql(connections: PgConnections, options: PgSqlOptions = {}): Sql
{
    const held = new AsyncLocalStorage<Held>();
    const alone = options.queue ?? (<Result,>(run: () => Promise<Result>) => run());

    const on = (client: PgClient, depth: number): Sql => ({
        dialect: "postgres",
        run: async (text, params) => ({ changes: (await client.query(numbered(text), params)).changes }),
        rows: async <Row,>(text: string, params?: readonly SqlValue[]) => (await client.query<Row>(numbered(text), params)).rows,
        exec: (script) => client.exec(script),
        transaction: (run) => savepoint({ client, depth }, run),
    });

    const savepoint = async <Result,>(at: Held, run: (inside: Sql) => Promise<Result>): Promise<Result> =>
    {
        const name = `kit_sp_${String(at.depth)}`;

        await at.client.exec(`SAVEPOINT ${name}`);

        try
        {
            const result = await held.run({ client: at.client, depth: at.depth + 1 }, () => run(on(at.client, at.depth + 1)));

            await at.client.exec(`RELEASE SAVEPOINT ${name}`);

            return result;
        }
        catch (cause)
        {
            await at.client.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);

            throw cause;
        }
    };

    const outside = on(connections.any, 0);

    return {
        ...outside,

        transaction: <Result,>(run: (inside: Sql) => Promise<Result>, caller = "The kit"): Promise<Result> =>
        {
            const open = held.getStore();

            if (open !== undefined)
            {
                return savepoint(open, run);
            }

            // on a connection the store shares, a BEGIN inside its transaction would only warn and join it
            if (options.isInsideStoreTransaction?.() === true)
            {
                return Promise.reject(new KernelFault(
                    "JOINED_TRANSACTION",
                    `${caller} asked for a transaction while another is open on this Postgres connection, and would have joined it without saying so: that one's rollback would undo this work too. Call ${caller} outside ctx.tx and store.tx.`,
                    { plugin: "" },
                ));
            }

            return alone(() => connections.hold(async (client) =>
            {
                await client.exec("BEGIN");

                try
                {
                    const result = await held.run({ client, depth: 1 }, () => run(on(client, 1)));

                    await client.exec("COMMIT");

                    return result;
                }
                catch (cause)
                {
                    await client.exec("ROLLBACK");

                    throw cause;
                }
            }));
        },
    };
}
