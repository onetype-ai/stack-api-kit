/**
 * The indexes a table declares, read off the table rather than imported.
 *
 * Same reason as `tableName`: the kernel holds no driver. Drizzle keeps the
 * extra config as a builder, so it is run once with the columns it was given
 * and each entry read for the name it carries and whether it is unique.
 *
 * Empty for anything that is not a table, or a table declaring none.
 */
export type DeclaredIndex = {
    name: string;
    unique: boolean;
};

export function tableIndexes(table: unknown): DeclaredIndex[]
{
    if (table === null || typeof table !== "object")
    {
        return [];
    }

    const bag = table as Record<symbol, unknown>;
    const symbols = Object.getOwnPropertySymbols(table);
    const builder = symbols.find((key) => key.description === "drizzle:ExtraConfigBuilder");
    const columns = symbols.find((key) => key.description === "drizzle:ExtraConfigColumns");

    if (builder === undefined || columns === undefined || typeof bag[builder] !== "function")
    {
        return [];
    }

    let built: unknown;

    // A builder of a shape this does not know is not a reason to refuse a
    // boot: an index nobody could read is one nobody can check, and the
    // check exists to catch a missing one, not to police drizzle.
    try
    {
        built = (bag[builder] as (given: unknown) => unknown)(bag[columns]);
    }
    catch
    {
        return [];
    }

    const entries = Array.isArray(built) ? built : Object.values(built as Record<string, unknown>);
    const found: DeclaredIndex[] = [];

    for (const entry of entries)
    {
        if (entry === null || typeof entry !== "object")
        {
            continue;
        }

        const config = (entry as Record<string, unknown>)["config"];

        if (config === null || typeof config !== "object")
        {
            continue;
        }

        const { name, unique } = config as { name?: unknown; unique?: unknown };

        if (typeof name === "string")
        {
            found.push({ name, unique: unique === true });
        }
    }

    return found;
}
