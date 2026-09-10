/** The name a table carries in the database. */
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
