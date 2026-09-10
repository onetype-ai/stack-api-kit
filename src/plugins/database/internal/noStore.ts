import type { MigrationSource, MigrationStep, Store } from "../api";

/** What stands in for a database nobody asked for. */
export function noStore(): Store
{
    const refuse = (what: string): never =>
    {
        throw new TypeError(`${what} needs a database, and start() was given none. Pass one: database: { file: "./data/app.db" }, or a store of your own.`);
    };

    return {
        forPlugin: (plugin: string) => refuse(`"${plugin}" reached ctx.db, which`),
        tx: (plugin: string) => refuse(`"${plugin}" opened a transaction, which`),
        write: () => refuse("A write"),
        inTransaction: () => false,

        migrate: (sources: readonly MigrationSource[]): MigrationStep[] => sources.length === 0 ? [] : refuse("A migration"),
        close: () => {},
    };
}
