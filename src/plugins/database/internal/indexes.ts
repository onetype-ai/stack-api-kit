import * as pg from "drizzle-orm/pg-core";
import * as lite from "drizzle-orm/sqlite-core";

import { dialect } from "./dialect";

import type { SQL } from "drizzle-orm";

type IndexRecord = { name: string; isUnique: boolean; on: unknown[]; where: SQL | undefined };

const INDEX = Symbol("portable index");

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

/** The index a portable one becomes on this process's dialect. */
export function realIndex(portable: unknown): unknown
{
    const record = (portable as Record<symbol, IndexRecord>)[INDEX] as IndexRecord;

    const make = dialect() === "postgres" ? (record.isUnique ? pg.uniqueIndex : pg.index) : (record.isUnique ? lite.uniqueIndex : lite.index);
    const [first, ...rest] = record.on as [never, ...never[]];
    const on = (make(record.name) as { on: (...columns: never[]) => { where: (condition: SQL) => unknown } }).on(first, ...rest);

    return record.where === undefined ? on : on.where(record.where);
}
