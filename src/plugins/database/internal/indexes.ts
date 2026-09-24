import * as pg from "drizzle-orm/pg-core";
import * as lite from "drizzle-orm/sqlite-core";

import { KernelFault } from "../../kernel/api";

import { dialect } from "./dialect";

import type { SQL } from "drizzle-orm";

type IndexRecord = { name: string; isUnique: boolean; on: unknown[]; where: SQL | undefined };

type KeyRecord = { name: string | undefined; columns: unknown[] };

const INDEX = Symbol("portable index");
const KEY = Symbol("portable primary key");

function indexOf(name: string, isUnique: boolean): ReturnType<typeof lite.index>
{
    const record: IndexRecord = { name, isUnique, on: [], where: undefined };
    const chain = {
        [INDEX]: record,
        on: (...columns: unknown[]) =>
        {
            record.on = columns;

            return chain;
        },
        where: (condition: SQL) =>
        {
            record.where = condition;

            return chain;
        },
    };

    return chain as unknown as ReturnType<typeof lite.index>;
}

/** An index, portable: `.on(...)` and, for a partial one, `.where(sql\`...\`)`. */
export const index = (name: string): ReturnType<typeof lite.index> => indexOf(name, false);
export const uniqueIndex = (name: string): ReturnType<typeof lite.uniqueIndex> => indexOf(name, true);

/** A primary key of several columns, portable: `primaryKey({ columns: [t.workspaceId, t.visitorId] })`. */
export function primaryKey(config: { columns: readonly unknown[]; name?: string }): ReturnType<typeof lite.primaryKey>
{
    const record: KeyRecord = { name: config.name, columns: [...config.columns] };

    return { [KEY]: record } as unknown as ReturnType<typeof lite.primaryKey>;
}

/** The index or key a portable one becomes on this process's dialect. */
export function realIndex(portable: unknown): unknown
{
    const key = (portable as Record<symbol, KeyRecord | undefined>)[KEY];

    if (key !== undefined)
    {
        const settings = { columns: key.columns as [never, ...never[]], ...(key.name !== undefined && { name: key.name }) };

        return dialect() === "postgres" ? pg.primaryKey(settings) : lite.primaryKey(settings);
    }

    const record = (portable as Record<symbol, IndexRecord | undefined>)[INDEX];

    if (record === undefined)
    {
        throw new KernelFault("UNPORTABLE_COLUMN", "A portable table's extras hold something not made with index, uniqueIndex or primaryKey from @onetype/stack-api-kit/tables. Make each with those.", { plugin: "database" });
    }

    const make = dialect() === "postgres" ? (record.isUnique ? pg.uniqueIndex : pg.index) : (record.isUnique ? lite.uniqueIndex : lite.index);
    const [first, ...rest] = record.on as [never, ...never[]];
    const on = (make(record.name) as { on: (...columns: never[]) => { where: (condition: SQL) => unknown } }).on(first, ...rest);

    return record.where === undefined ? on : on.where(record.where);
}
