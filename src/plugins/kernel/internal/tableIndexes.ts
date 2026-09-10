/** The indexes a table declares, read off the table rather than imported. */
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

    try
    {
        built = (bag[builder] as (given: unknown) => unknown)(bag[columns]);
    }
    catch
    {
        return [];
    }

    const entries = Array.isArray(built) ? built : Object.values(built as Record<string, unknown>);
    const indexes: DeclaredIndex[] = [];

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
            indexes.push({ name, unique: unique === true });
        }
    }

    return indexes;
}
