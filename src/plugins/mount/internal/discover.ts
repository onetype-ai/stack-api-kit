import type { Plugin } from "../../kernel/api";

export type Modules = Readonly<Record<string, { default?: Plugin }>>;

// Discovery from the filesystem with no list to maintain: adding a plugin is
// a folder, and forgetting to register it is not a failure mode. Sorted so
// one set is always one order, whatever the loader walked first.
export function discover(found: Modules): Plugin[]
{
    return Object.entries(found)
        .map(([path, module]) =>
        {
            if (module.default === undefined)
            {
                throw new Error(`${path} must default-export a definePlugin(...) result.`);
            }

            return module.default;
        })
        .sort((first, second) => first.name.localeCompare(second.name));
}
