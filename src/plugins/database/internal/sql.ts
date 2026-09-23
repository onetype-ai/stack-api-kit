import { AsyncLocalStorage } from "node:async_hooks";

import type Database from "better-sqlite3";

import { KernelFault } from "../../kernel/api";

import { queue as ownQueue } from "./queue";

/** Which SQL the database speaks. One per deployment. */
export type Dialect = "sqlite" | "postgres";

/** A value a statement may carry. */
export type SqlValue = string | number | boolean | null;

/**
 * What the kit's own tables (the outbox, the schedule, the migration ledger) are written against, so each is written
 * once for every dialect. Statements use `?` for a parameter and double quotes around every identifier: Postgres
 * folds an unquoted one to lower case, SQLite keeps it, and quoting makes both read the same column.
 */
export type Sql = {
    dialect: Dialect;

    /** Runs one statement, answering how many rows it changed. */
    run: (text: string, params?: readonly SqlValue[]) => Promise<{ changes: number }>;

    /** Runs one statement, answering its rows. */
    rows: <Row>(text: string, params?: readonly SqlValue[]) => Promise<Row[]>;

    /** Runs a script of several statements, carrying no parameters. */
    exec: (script: string) => Promise<void>;

    /**
     * Runs work in one transaction on this connection, rolled back if it throws; one inside another of its own is a
     * savepoint. `caller` names who asked, for the refusal when someone else's transaction is already open.
     */
    transaction: <Result>(run: (inside: Sql) => Promise<Result>, caller?: string) => Promise<Result>;

    /** The same, answering at once, where the driver does: SQLite prepares the kit's tables before its factory returns. */
    now?: {
        rows: <Row>(text: string, params?: readonly SqlValue[]) => Row[];
        exec: (script: string) => void;
    };
};

/** SQLite's answer when another connection holds the write lock. */
function isBusy(cause: unknown): boolean
{
    return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code: unknown }).code === "SQLITE_BUSY";
}

/**
 * Takes the write lock without blocking the thread. SQLite's own busy wait blocks it, and a transaction that awaits
 * while holding the lock then cannot finish when the connection waiting for it lives in the same process: both would
 * wait out the timeout. So the lock is tried with no wait, and tried again after a pause, until the same timeout.
 */
export async function beginImmediate(connection: Database.Database): Promise<void>
{
    const timeoutMs = Number(connection.pragma("busy_timeout", { simple: true }));
    const deadline = Date.now() + timeoutMs;

    for (let pauseMs = 5; ; pauseMs = Math.min(pauseMs * 2, 100))
    {
        connection.pragma("busy_timeout = 0");

        try
        {
            connection.exec("BEGIN IMMEDIATE");

            return;
        }
        catch (cause)
        {
            if (!isBusy(cause) || Date.now() >= deadline)
            {
                throw cause;
            }
        }
        finally
        {
            connection.pragma(`busy_timeout = ${String(timeoutMs)}`);
        }

        await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
}

/** Where a factory of the kit's tables runs its statements: `within` a transaction's own handle, and `outside` one. */
export type Around = {
    /** The statements a transaction's own handle runs, where the database needs its connection; SQLite answers the one. */
    within?: (db: unknown) => Sql;

    /** Runs work that must not land inside a transaction someone else opened; left out, it runs as it comes. */
    outside?: <Result>(run: () => Promise<Result>) => Promise<Result>;
};

/** The same SQL over one better-sqlite3 connection, which answers at once. */
export function sqliteSql(connection: Database.Database, queue?: <Result>(run: () => Promise<Result>) => Promise<Result>): Sql
{
    const prepared = new Map<string, Database.Statement>();

    /** How deep this chain of calls is in its own transaction: a call from another chain is not nested, whatever is open. */
    const nesting = new AsyncLocalStorage<number>();

    /** Where a transaction waits for the one before it: the store's queue when one is given, else this connection's own. */
    const alone = queue ?? ownQueue().run;

    const savepoint = async <Result,>(depth: number, run: (inside: Sql) => Promise<Result>): Promise<Result> =>
    {
        const name = `kit_sp_${String(depth)}`;

        connection.exec(`SAVEPOINT ${name}`);

        try
        {
            const result = await nesting.run(depth + 1, () => run(sql));

            connection.exec(`RELEASE ${name}`);

            return result;
        }
        catch (cause)
        {
            connection.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);

            throw cause;
        }
    };

    const statement = (text: string): Database.Statement =>
    {
        const existing = prepared.get(text);

        if (existing !== undefined)
        {
            return existing;
        }

        const made = connection.prepare(text);

        prepared.set(text, made);

        return made;
    };

    const sql: Sql = {
        dialect: "sqlite",

        now: {
            rows: <Row,>(text: string, params: readonly SqlValue[] = []) => statement(text).all(...params) as Row[],
            exec: (script: string) =>
            {
                connection.exec(script);
            },
        },

        run: (text, params = []) =>
        {
            return Promise.resolve({ changes: statement(text).run(...params).changes });
        },

        rows: <Row,>(text: string, params: readonly SqlValue[] = []) =>
        {
            return Promise.resolve(statement(text).all(...params) as Row[]);
        },

        exec: (script) =>
        {
            connection.exec(script);

            return Promise.resolve();
        },

        transaction: <Result,>(run: (inside: Sql) => Promise<Result>, caller = "The kit"): Promise<Result> =>
        {
            const depth = nesting.getStore() ?? 0;

            // only this chain's own transaction is nested; any other waits its turn in the queue
            if (depth > 0)
            {
                return savepoint(depth, run);
            }

            return alone(async () =>
            {
                // a transaction someone else opened is not this one's to join: its rollback would undo this work too
                if (connection.inTransaction)
                {
                    throw new KernelFault(
                        "JOINED_TRANSACTION",
                        `${caller} asked for a transaction while another is open on this SQLite connection, and would have joined it without saying so: that one's rollback would undo this work too. Call ${caller} outside ctx.tx and store.tx.`,
                        { plugin: "" },
                    );
                }

                await beginImmediate(connection);

                try
                {
                    const result = await nesting.run(1, () => run(sql));

                    connection.exec("COMMIT");

                    return result;
                }
                catch (cause)
                {
                    connection.exec("ROLLBACK");

                    throw cause;
                }
            });
        },
    };

    return sql;
}

/**
 * The same SQL, each statement run through `outside`: the store's queue for work that must never land inside a
 * transaction someone else opened, where that one's rollback would undo it (a lease taken, a row marked sent).
 *
 * Each statement is queued on its own, so this holds only while every claim, renewal and mark is one atomic
 * statement. Splitting one into a SELECT and an UPDATE would let another write land between them.
 */
export function serialized(sql: Sql, outside: <Result>(run: () => Promise<Result>) => Promise<Result>): Sql
{
    return {
        ...sql,
        run: (text, params) => outside(() => sql.run(text, params)),
        rows: <Row,>(text: string, params?: readonly SqlValue[]) => outside(() => sql.rows<Row>(text, params)),
        exec: (script) => outside(() => sql.exec(script)),
    };
}

