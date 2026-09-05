import { connect, type DatabaseOptions } from "./internal/connect";
import { migrate, MigrationFault, type Source, type Step, steps } from "./internal/migrate";
import { createScopeFilter } from "./internal/narrow";
import { outbox } from "./internal/outbox";
import { schedule } from "./internal/schedule";

import type { ScopeFilter, Outbox, Schedule } from "../kernel/api";
import { store, type Handle, type Tables } from "./internal/store";

/** What building a store needs: where the file is, and who owns what. */
export type StoreOptions = DatabaseOptions & {
    tables: Readonly<Record<string, Tables>>;
};

/**
 * What a project holds after opening a database.
 *
 * Wider than the kernel's `Storage`: this one also migrates and closes, which
 * a plugin has no business doing and the kernel never asks for.
 */
/**
 * What `start` needs of a database, whichever one it is.
 *
 * Wider than the kernel's `Storage`: this one also migrates and closes, which
 * a plugin has no business doing and the kernel never asks for. `of` answers
 * `unknown` because the kit does not know what database it was given; a
 * plugin names the shape it expects through `definePlugin.over`.
 */
export type Store<Handle = unknown> = {
    of: (plugin: string) => Handle;

    /** An outbox in this same database, when the store can hold one. */
    outbox?: () => Outbox;

    /** A schedule in this same database, for work asked for later. */
    schedule?: () => Schedule;

    /** How a declared scope becomes a condition over the tables it was given. */
    createScopeFilter?: () => ScopeFilter;
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>;
    write: <Result>(run: () => Promise<Result>) => Promise<Result>;
    inTransaction: () => boolean;
    migrate: (sources: readonly Source[]) => Step[];
    close: () => void;
};

export { MigrationFault, createScopeFilter, outbox, schedule, steps };
export type { Handle, DatabaseOptions, Source, Step, Tables };

/**
 * Opens a database and holds one handle per plugin over it.
 *
 * Built by the project rather than reached for: two stores can exist in one
 * process without seeing each other, which is what a test needs.
 */
export function database(settings: StoreOptions): Store<Handle>
{
    const connection = connect(settings);
    const made = store({ connection, tables: settings.tables });

    return {
        of: made.of,
        tx: made.tx,
        write: made.write,
        inTransaction: made.inTransaction,
        close: made.close,

        /** Runs every migration that has not run, in the order given. */
        migrate: (sources: readonly Source[]): Step[] =>
        {
            return migrate(connection, sources);
        },

        /**
         * Where events wait, in this same database.
         *
         * Built here rather than from a connection handed out, because an
         * outbox that wrote somewhere else would be exactly the thing it
         * exists to prevent: two places that can disagree about whether the
         * work happened.
         */
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
