import type Database from "better-sqlite3";

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

    /** Runs work in one transaction on this connection, rolled back if it throws; one inside another is a savepoint. */
    transaction: <Result>(run: (inside: Sql) => Promise<Result>) => Promise<Result>;

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
async function beginImmediate(connection: Database.Database): Promise<void>
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

/** The same SQL over one better-sqlite3 connection, which answers at once. */
export function sqliteSql(connection: Database.Database): Sql
{
    const prepared = new Map<string, Database.Statement>();
    let depth = 0;

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

        transaction: async <Result,>(run: (inside: Sql) => Promise<Result>): Promise<Result> =>
        {
            const name = `kit_sp_${String(depth)}`;
            const nested = depth > 0 || connection.inTransaction;

            if (nested)
            {
                connection.exec(`SAVEPOINT ${name}`);
            }
            else
            {
                await beginImmediate(connection);
            }

            depth += 1;

            try
            {
                const result = await run(sql);

                connection.exec(nested ? `RELEASE ${name}` : "COMMIT");

                return result;
            }
            catch (cause)
            {
                connection.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");

                throw cause;
            }
            finally
            {
                depth -= 1;
            }
        },
    };

    return sql;
}
