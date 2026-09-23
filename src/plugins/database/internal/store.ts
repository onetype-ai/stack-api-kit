import { AsyncLocalStorage } from "node:async_hooks";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { queue } from "./queue";
import { beginImmediate } from "./sql";

/** One plugin's drizzle tables keyed by the name its contract declares them under; the values are opaque here so the kit never depends on a drizzle table's shape. */
export type TablesByName = Readonly<Record<string, unknown>>;

export type StoreInternals = {
    connection: Database.Database;
    tables: Readonly<Record<string, TablesByName>>;
};

/** A drizzle handle over the one shared better-sqlite3 connection, scoped to a single plugin's tables; asking for one for a plugin declaring no tables throws. */
export type DrizzleDb = ReturnType<typeof drizzle>;

/** One connection, and one handle per plugin over it. */
export function store(holding: StoreInternals)
{
    const handles = new Map<string, DrizzleDb>();
    const writes = queue();

    /** Which transaction the running code is inside, if any. */
    const inside = new AsyncLocalStorage<number>();

    /** The transactions open right now. Work started inside one carries its turn past the commit, so a turn counts only while it is here. */
    const live = new Set<number>();

    /** The open transaction the running code belongs to, or undefined: a turn whose transaction has ended belongs to none. */
    const current = (): number | undefined =>
    {
        const turn = inside.getStore();

        return turn !== undefined && live.has(turn) ? turn : undefined;
    };

    let open = true;
    let counter = 0;

    function forPlugin(plugin: string): DrizzleDb
    {
        if (!open)
        {
            throw new Error(`"${plugin}" reached the database after it was closed.`);
        }

        const existing = handles.get(plugin);

        if (existing !== undefined)
        {
            return existing;
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
        // a plugin with no tables still opens one, to emit through the outbox; it is handed no handle
        const db = holding.tables[plugin] === undefined ? undefined : forPlugin(plugin);
        const nested = current() !== undefined;

        counter += 1;

        const turn = counter;
        const name = `sp_${String(turn)}`;

        if (nested)
        {
            holding.connection.exec(`SAVEPOINT ${name}`);
        }
        else
        {
            await beginImmediate(holding.connection);
        }

        live.add(turn);

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
        finally
        {
            live.delete(turn);
        }
    }

    return {
        forPlugin,

        /** Runs work in one transaction, rolled back if it throws. */
        tx: <Result,>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result> =>
        {
            return current() === undefined ? writes.run(() => inTx(plugin, run)) : inTx(plugin, run);
        },

        /** Runs work outside a transaction, but never during someone else's. */
        write: <Result,>(run: () => Promise<Result>): Promise<Result> =>
        {
            return current() === undefined ? writes.run(run) : run();
        },

        /** Whether the running code is inside a transaction. For diagnosis. */
        inTransaction: (): boolean =>
        {
            return current() !== undefined;
        },

        close: (): Promise<void> =>
        {
            open = false;
            handles.clear();
            holding.connection.close();

            return Promise.resolve();
        },
    };
}
