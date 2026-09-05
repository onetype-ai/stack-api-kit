import { eq } from "drizzle-orm";

import type { ScopeFilter } from "../../kernel/api";

type Column = Readonly<Record<string, unknown>>;

/**
 * Turns a declared scope into a condition.
 *
 * The kernel knows which table and which column, and nothing about how a
 * query is built. This knows Drizzle and nothing about tenants, so neither
 * half has to learn the other's business.
 */
export function createScopeFilter(owned: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ScopeFilter
{
    return (table: string, column: string, value: string): unknown =>
    {
        // Table names are unique across the store, because a plugin's tables
        // live in its own namespace and the kernel checked that at startup.
        const found = Object.values(owned)
            .map((tables) => tables[table])
            .find((one) => one !== undefined) as Column | undefined;

        if (found === undefined)
        {
            throw new Error(`Cannot scope "${table}": no table of that name was given to the store.`);
        }

        const at = found[column];

        if (at === undefined)
        {
            throw new Error(`Cannot scope "${table}" by "${column}": the table declares no such column.`);
        }

        return eq(at as Parameters<typeof eq>[0], value);
    };
}
