import type { Source, Step, Store } from "../api";

/**
 * What stands in for a database nobody asked for.
 *
 * A project with no tables keeps no rows, so opening a connection to prove it
 * would spend a file handle on nothing. Every method refuses instead, naming
 * what to pass: reaching one of these means a plugin wants storage after all,
 * and the message says so where the failure happens.
 */
export function noStore(): Store
{
    const refuse = (what: string): never =>
    {
        throw new TypeError(`${what} needs a database, and start() was given none. Pass one: database: { file: "./data/app.db" }, or a store of your own.`);
    };

    return {
        of: (plugin: string) => refuse(`"${plugin}" reached ctx.db, which`),
        tx: (plugin: string) => refuse(`"${plugin}" opened a transaction, which`),
        write: () => refuse("A write"),
        inTransaction: () => false,

        // Nothing declared tables, so nothing declared migrations either:
        // answering an empty run is the truth, not a stub.
        migrate: (sources: readonly Source[]): Step[] => sources.length === 0 ? [] : refuse("A migration"),
        close: () => {},
    };
}
