import * as pg from "drizzle-orm/pg-core";
import * as lite from "drizzle-orm/sqlite-core";

import { KernelFault } from "../../kernel/api";

import { dialect } from "./dialect";

type Kind = "id" | "text" | "integer" | "timeMs" | "boolean" | "json" | "real";

type Recorded = { kind: Kind; name: string; calls: { method: string; args: unknown[] }[] };

const RECORDED = Symbol("portable column");

/** What reading a value for its own sake asks of it: never a builder method, so never refused. */
const QUIET = new Set(["then", "toJSON", "constructor", "inspect", "toString", "valueOf"]);

/** What a portable column may be told, the same on both dialects. */
const PORTABLE = new Set(["notNull", "default", "$defaultFn", "primaryKey", "references", "$type", "unique"]);

/**
 * A portable column is typed as the SQLite builder it becomes there, so a row infers exactly as it always did. At
 * runtime it only records what it is told, replayed on the builder of whichever dialect the process uses.
 */
function recorder<Builder>(kind: Kind, name: string): Builder
{
    const recorded: Recorded = { kind, name, calls: [] };

    const column: unknown = new Proxy({}, {
        get: (_target, property) =>
        {
            if (property === RECORDED)
            {
                return recorded;
            }

            // what inspecting, awaiting or serialising a value reads is no builder method, and answers nothing
            if (typeof property === "symbol" || QUIET.has(property))
            {
                return undefined;
            }

            if (!PORTABLE.has(property))
            {
                return () =>
                {
                    throw new KernelFault(
                        "UNPORTABLE_COLUMN",
                        `database: column "${name}" was told ${property}, which is not in the portable set. Use ${[...PORTABLE].join(", ")}, or define the column for one dialect with a table of that dialect.`,
                        { plugin: "database" },
                    );
                };
            }

            return (...args: unknown[]) =>
            {
                recorded.calls.push({ method: property, args });

                return column;
            };
        },
    });

    return column as Builder;
}

type Text = lite.SQLiteTextBuilderInitial<"", [string, ...string[]], undefined>;
type Whole = lite.SQLiteIntegerBuilderInitial<"">;

/** The columns a table may hold on both dialects. */
export const column = {
    /** A text id, a UUID by convention. */
    id: (name = "id"): Text => recorder<Text>("id", name),
    text: (name: string): Text => recorder<Text>("text", name),

    /** A 32-bit integer: a count, a position. A time or anything past 2^31 is `timeMs`. */
    integer: (name: string): Whole => recorder<Whole>("integer", name),

    /** Epoch milliseconds: `bigint` on Postgres, read back as a number. */
    timeMs: (name: string): Whole => recorder<Whole>("timeMs", name),
    boolean: (name: string): lite.SQLiteBooleanBuilderInitial<""> => recorder<lite.SQLiteBooleanBuilderInitial<"">>("boolean", name),

    /** A JSON value: text on SQLite, `jsonb` on Postgres. */
    json: <Shape>(name: string): lite.SQLiteTextJsonBuilderInitial<""> & { _: { data: Shape } } => recorder<lite.SQLiteTextJsonBuilderInitial<""> & { _: { data: Shape } }>("json", name),
    real: (name: string): lite.SQLiteRealBuilderInitial<""> => recorder<lite.SQLiteRealBuilderInitial<"">>("real", name),
};

/** The column a portable one becomes on this process's dialect. */
export function realColumn(portable: unknown): unknown
{
    const recorded = (portable as Record<symbol, Recorded | undefined>)[RECORDED];

    if (recorded === undefined)
    {
        throw new KernelFault("UNPORTABLE_COLUMN", "database: a portable table holds a column not made with column.*. Make every column of it with column.text, column.integer and the rest.", { plugin: "database" });
    }

    const { kind, name } = recorded;
    const postgres = dialect() === "postgres";

    const builders: Readonly<Record<Kind, () => unknown>> = postgres
        ? { id: () => pg.text(name), text: () => pg.text(name), integer: () => pg.integer(name), timeMs: () => pg.bigint(name, { mode: "number" }), boolean: () => pg.boolean(name), json: () => pg.jsonb(name), real: () => pg.doublePrecision(name) }
        : { id: () => lite.text(name), text: () => lite.text(name), integer: () => lite.integer(name), timeMs: () => lite.integer(name), boolean: () => lite.integer(name, { mode: "boolean" }), json: () => lite.text(name, { mode: "json" }), real: () => lite.real(name) };

    let builder = builders[kind]() as Record<string, (...args: unknown[]) => unknown>;

    for (const call of recorded.calls)
    {
        const told = builder[call.method];

        if (told === undefined)
        {
            throw new KernelFault("UNPORTABLE_COLUMN", `database: column "${name}": ${call.method} has no ${dialect()} form.`, { plugin: "database" });
        }

        builder = told.apply(builder, call.args) as typeof builder;
    }

    return builder;
}
