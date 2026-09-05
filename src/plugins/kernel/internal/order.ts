import type { Plugin } from "./contract";

/**
 * Dependency order: every plugin comes after the ones it depends on.
 *
 * Ties break by name, so one set securityHeaders yields one order. A run that varied
 * would make what a plugin sees at setup depend on iteration order.
 */
export function order(known: ReadonlyMap<string, Plugin>): Plugin[]
{
    const sorted: Plugin[] = [];
    const state = new Map<string, "open" | "done">();

    function walk(name: string): void
    {
        if (state.get(name) !== undefined)
        {
            return;
        }

        state.set(name, "open");

        const plugin = known.get(name);

        for (const need of [...(plugin?.definition.dependsOn ?? [])].sort())
        {
            if (known.has(need))
            {
                walk(need);
            }
        }

        state.set(name, "done");

        if (plugin !== undefined)
        {
            sorted.push(plugin);
        }
    }

    for (const name of [...known.keys()].sort())
    {
        walk(name);
    }

    return sorted;
}
