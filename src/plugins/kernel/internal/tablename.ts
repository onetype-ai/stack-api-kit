/**
 * The name a table carries in the database.
 *
 * Read off the table rather than imported, because the kernel holds no
 * driver: a symbol described "drizzle:Name" is what every dialect stamps on
 * one, and reading it by description costs nothing a dependency would.
 *
 * Undefined for anything that is not a table, which the caller treats as the
 * key it was declared under: a project may pass a store of its own.
 */
export function tableName(table: unknown): string | undefined
{
    if (table === null || typeof table !== "object")
    {
        return undefined;
    }

    for (const key of Object.getOwnPropertySymbols(table))
    {
        if (key.description === "drizzle:Name")
        {
            const name = (table as Record<symbol, unknown>)[key];

            if (typeof name === "string")
            {
                return name;
            }
        }
    }

    return undefined;
}
