import { AsyncLocalStorage } from "node:async_hooks";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { queue } from "./queue";

export type TablesByName = Readonly<Record<string, unknown>>;

export type StoreInternals = {
    connection: Database.Database;
    tables: Readonly<Record<string, TablesByName>>;
};

export type DrizzleDb = ReturnType<typeof drizzle>;

/** One connection, and one handle per plugin over it. */
export function store(holding: StoreInternals)
{
    const handles = new Map<string, DrizzleDb>();
    const writes = queue();

    /** Which transaction the running code is inside, if any. */
    const inside = new AsyncLocalStorage<number>();

    let open = true;
    let counter = 0;

    function forPlugin(plugin: string): DrizzleDb
    {
        if (!open)
        {
            throw new Error(`"${plugin}" reached the database after it was closed.`);
        }

        const already = handles.get(plugin);

        if (already !== undefined)
        {
            return already;
        }

        const owns = holding.tables[plugin];

        if (owns === undefined)
        {
            throw new Error(`"${plugin}" asked for a database handle but declares no tables. Add them to its contract, or stop reaching for ctx.db.`);
        }

        const handle = drizzle(holding.connection, { schema: owns });

        handles.set(plugin, handle);

        return handle;
    }

    /** One transaction, or a savepoint when one is already open. */
    async function inTx<Result>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result>
    {
        const db = forPlugin(plugin);
        const nested = inside.getStore() !== undefined;

        counter += 1;

        const turn = counter;
        const name = `sp_${String(turn)}`;

        holding.connection.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");

        try
        {
            const handle = await inside.run(turn, () => run(db));

            holding.connection.exec(nested ? `RELEASE ${name}` : "COMMIT");

            return handle;
        }
        catch (cause)
        {
            try
            {
                holding.connection.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
            }
            catch
            {
            }

            throw cause;
        }
    }

    return {
        forPlugin,

        /** Runs work in one transaction, rolled back if it throws. */
        tx: <Result,>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result> =>
        {
            return inside.getStore() === undefined ? writes.run(() => inTx(plugin, run)) : inTx(plugin, run);
        },

        /** Runs work outside a transaction, but never during someone else's. */
        write: <Result,>(run: () => Promise<Result>): Promise<Result> =>
        {
            return inside.getStore() === undefined ? writes.run(run) : run();
        },

        /** Whether the running code is inside a transaction. For diagnosis. */
        inTransaction: (): boolean =>
        {
            return inside.getStore() !== undefined;
        },

        close: (): void =>
        {
            open = false;
            handles.clear();
            holding.connection.close();
        },
    };
}
