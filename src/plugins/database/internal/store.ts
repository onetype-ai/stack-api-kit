import { AsyncLocalStorage } from "node:async_hooks";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { queue } from "./queue";

export type Tables = Readonly<Record<string, unknown>>;

export type Holding = {
    connection: Database.Database;
    tables: Readonly<Record<string, Tables>>;
};

export type Handle = ReturnType<typeof drizzle>;

/**
 * One connection, and one handle per plugin over it.
 *
 * The handle carries only that plugin's tables, so a query naming another
 * plugin's table does not compile. That is a compile-time boundary, not a
 * physical one: the connection underneath is shared, and a plugin importing
 * another's table object, or reaching `$client`, gets past it. SQLite gives
 * one connection, and a connection per plugin would make a transaction across
 * two plugins impossible, which costs more than it buys.
 */
export function store(holding: Holding)
{
    const handles = new Map<string, Handle>();
    const waiting = queue();

    /**
     * Which transaction the running code is inside, if any.
     *
     * A counter would say a transaction is open, never that *this* call is
     * the one inside it: while a transaction waits on the network, the next
     * one off the queue would read that counter, believe itself nested, and
     * open a savepoint inside a stranger's transaction.
     */
    const inside = new AsyncLocalStorage<number>();

    let open = true;
    let counter = 0;

    function of(plugin: string): Handle
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

        const made = drizzle(holding.connection, { schema: owns });

        handles.set(plugin, made);

        return made;
    }

    /**
     * One transaction, or a savepoint when one is already open.
     *
     * The savepoint's name is its own, not its depth: a name taken from a
     * shared counter is a name another call has moved by the time this one
     * releases it, and SQLite answers "no such savepoint" to the request that
     * did nothing wrong.
     */
    async function within<Result>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result>
    {
        const db = of(plugin);
        const nested = inside.getStore() !== undefined;

        counter += 1;

        const at = counter;
        const name = `sp_${String(at)}`;

        holding.connection.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");

        try
        {
            const made = await inside.run(at, () => run(db));

            holding.connection.exec(nested ? `RELEASE ${name}` : "COMMIT");

            return made;
        }
        catch (cause)
        {
            try
            {
                holding.connection.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
            }
            catch
            {
                // Already unwound by SQLite itself. The original cause is what
                // the caller needs, never this.
            }

            throw cause;
        }
    }

    return {
        of,

        /**
         * Runs work in one transaction, rolled back if it throws.
         *
         * Serialised against every other transaction and every write: this is
         * async but better-sqlite3 is not, so an await inside would otherwise
         * leave the connection in a transaction while other work ran through
         * it. That work would then belong to this transaction, and vanish
         * with its rollback.
         *
         * A transaction already open on this call stack becomes a savepoint
         * rather than queueing behind itself, which would deadlock.
         */
        tx: <Result,>(plugin: string, run: (db: unknown) => Promise<Result>): Promise<Result> =>
        {
            // Already inside one on this call stack: a savepoint, and never
            // queued behind the transaction it is inside, which would wait
            // for itself.
            return inside.getStore() === undefined ? waiting.run(() => within(plugin, run)) : within(plugin, run);
        },

        /**
         * Runs work outside a transaction, but never during someone else's.
         *
         * better-sqlite3 is synchronous, so one statement cannot interleave
         * with another. What can interleave is a statement issued while an
         * async transaction is parked on an await: it joins that transaction
         * and is undone by its rollback, having told its caller it succeeded.
         *
         * The kernel routes every non-transactional query through here, so
         * that window does not exist. It always queues: `depth` says a
         * transaction is open somewhere, never that this caller is the one
         * inside it, and work that is genuinely inside one reaches the
         * database through the transaction's own handle instead.
         */
        write: <Result,>(run: () => Promise<Result>): Promise<Result> =>
        {
            return inside.getStore() === undefined ? waiting.run(run) : run();
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
