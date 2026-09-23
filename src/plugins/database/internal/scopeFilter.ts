import { eq } from "drizzle-orm";

import type { ScopeFilter } from "../../kernel/api";

type Column = Readonly<Record<string, unknown>>;

/** Turns a declared scope into a condition. */
export function createScopeFilter(tablesByPlugin: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ScopeFilter
{
    return (table: string, column: string, value: string, plugin?: string): unknown =>
    {
        // the plugin's own table when it is named: another plugin's table of the same name is another column
        const columns = (plugin === undefined
            ? Object.values(tablesByPlugin).map((tables) => tables[table]).find((column) => column !== undefined)
            : tablesByPlugin[plugin]?.[table]) as Column | undefined;

        if (columns === undefined)
        {
            throw new Error(`Cannot scope "${table}": no table of that name was given to the store.`);
        }

        const wanted = columns[column];

        if (wanted === undefined)
        {
            throw new Error(`Cannot scope "${table}" by "${column}": the table declares no such column.`);
        }

        return eq(wanted as Parameters<typeof eq>[0], value);
    };
}
