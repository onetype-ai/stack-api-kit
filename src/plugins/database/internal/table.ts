import * as pg from "drizzle-orm/pg-core";
import * as lite from "drizzle-orm/sqlite-core";

import { realColumn } from "./column";
import { dialect, noteBuilt } from "./dialect";
import { realIndex } from "./indexes";

import type { BuildColumns } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

type Portable<Name extends string, Columns extends Record<string, lite.SQLiteColumnBuilderBase>> =
    lite.SQLiteTableWithColumns<{ name: Name; schema: undefined; columns: BuildColumns<Name, Columns, "sqlite">; dialect: "sqlite" }>;

/**
 * One table for both dialects: typed as SQLite, built for the dialect this process uses. Its migrations are
 * generated from it, once for each dialect.
 */
export function table<Name extends string, Columns extends Record<string, lite.SQLiteColumnBuilderBase>>(
    name: Name,
    columns: Columns,
    extras?: (self: Portable<Name, Columns>) => unknown[],
): Portable<Name, Columns>
{
    const real = Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, realColumn(value)]));
    const realExtras = extras === undefined ? undefined : (self: never) => extras(self).map((entry) => realIndex(entry));

    noteBuilt(name);

    return (dialect() === "postgres"
        ? pg.pgTable(name, real as never, realExtras as never)
        : lite.sqliteTable(name, real as never, realExtras as never)) as never;
}

/**
 * What `ctx.db` is over portable tables: typed as the SQLite handle, so every query infers as it always did. `.get()`,
 * `.all()` and `.run()` answer on SQLite alone; the Project check `[dialect]` names them where they are written.
 */
export type PortableDb<Schema extends Record<string, unknown> = Record<string, never>> = BetterSQLite3Database<Schema>;
