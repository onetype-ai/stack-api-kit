import { KernelFault } from "../../kernel/api";

/** Which SQL a deployment speaks. One per deployment. */
export type Dialect = "sqlite" | "postgres";

let chosen: Dialect | undefined;

/** The tables built so far, named for the refusal when a database of another dialect arrives. */
const built: string[] = [];

/** Notes a table built for this process's dialect. */
export function noteBuilt(table: string): void
{
    built.push(table);
}

/**
 * The dialect this process builds its tables for, read once from the environment on first use: `KIT_DIALECT`, else
 * `postgres` when `DATABASE_URL` is a Postgres URL, else `sqlite`. Read here rather than set by `start`, because a
 * project imports its plugins, and with them their tables, before it starts anything.
 */
export function dialect(): Dialect
{
    if (chosen !== undefined)
    {
        return chosen;
    }

    const named = process.env["KIT_DIALECT"];

    if (named !== undefined && named !== "sqlite" && named !== "postgres")
    {
        throw new KernelFault("INVALID_CONFIG", `KIT_DIALECT is "${named}". Set it to sqlite or postgres, or leave it unset to follow DATABASE_URL.`, { plugin: "tables" });
    }

    chosen = named ?? (/^postgres(ql)?:\/\//u.test(process.env["DATABASE_URL"] ?? "") ? "postgres" : "sqlite");

    return chosen;
}

/** Refuses a database of another dialect than the one the tables were built for, naming both. */
export function refuseOtherDialect(database: Dialect): void
{
    if (built.length > 0 && dialect() !== database)
    {
        throw new KernelFault(
            "MIXED_DIALECT",
            `The tables ${built.slice(0, 3).join(", ")} were built for ${dialect()}, and the database is ${database}. Set KIT_DIALECT=${database}, or a DATABASE_URL naming it, before any plugin is imported.`,
            { plugin: "tables" },
        );
    }
}
