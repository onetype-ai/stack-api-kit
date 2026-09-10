import { connect, type DatabaseOptions } from "./internal/connect";
import { migrate, MigrationFault, type MigrationSource, type MigrationStep, migrationSteps } from "./internal/migrate";
import { createScopeFilter } from "./internal/scopeFilter";
import { noStore } from "./internal/noStore";
import { outbox } from "./internal/outbox";
import { schedule } from "./internal/schedule";

import { tableName } from "../kernel/api";

import type { ScopeFilter, Outbox, Schedule } from "../kernel/api";
import { store, type DrizzleDb, type TablesByName } from "./internal/store";

/** What building a store needs: where the file is, and who owns what. */
export type StoreOptions = DatabaseOptions & {
    tables: Readonly<Record<string, TablesByName>>;
};

/** What a project holds after opening a database. */
export type Store<Db = unknown> = {
    forPlugin: (plugin: string) => Db;

    /** An outbox in this same database, when the store can hold one. */
    outbox?: () => Outbox;

    /** A schedule in this same database, for work asked for later. */
    schedule?: () => Schedule;

    /** How a declared scope becomes a condition over the tables it was given. */
    createScopeFilter?: () => ScopeFilter;
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>;
    write: <Result>(run: () => Promise<Result>) => Promise<Result>;
    inTransaction: () => boolean;
    migrate: (sources: readonly MigrationSource[]) => MigrationStep[];
    close: () => void;
};

export { MigrationFault, createScopeFilter, noStore, outbox, schedule, migrationSteps };
export type { DrizzleDb, DatabaseOptions, MigrationSource, MigrationStep, TablesByName };

/** Every table name a plugin declared, as the database spells it. */
function declaredTables(owned: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string[]
{
    return Object.values(owned).flatMap((tables) =>
        Object.entries(tables).map(([key, table]) => tableName(table) ?? key));
}

/** Opens a database and holds one handle per plugin over it. */
export function database(settings: StoreOptions): Store<DrizzleDb>
{
    const connection = connect(settings);
    const backing = store({ connection, tables: settings.tables });

    return {
        forPlugin: backing.forPlugin,
        tx: backing.tx,
        write: backing.write,
        inTransaction: backing.inTransaction,
        close: backing.close,

        /** Runs every migration that has not run, in the order given. */
        migrate: (sources: readonly MigrationSource[]): MigrationStep[] =>
        {
            return migrate(connection, sources, declaredTables(settings.tables));
        },

        /** Where events wait, in this same database. */
        outbox: (): Outbox =>
        {
            return outbox(connection);
        },

        /** Where later work waits, in this same database. */
        schedule: (): Schedule =>
        {
            return schedule(connection);
        },

        /** How a scope narrows a query, over the tables one plugin declared. */
        createScopeFilter: (): ScopeFilter =>
        {
            return createScopeFilter(settings.tables);
        },
    };
}
