import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "../../kernel/api";

export type PluginModules = Readonly<Record<string, { default?: Plugin }>>;

export function discover(modules: PluginModules): Plugin[]
{
    return Object.entries(modules)
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


/** What discoverFrom leaves behind: a folder it could not take. */
export type SkippedFolder = {
    folder: string;
    why: string;
};

/** What discoverFrom answers: what it modules, and what it stepped over. */
export type DiscoveryResult = {
    plugins: Plugin[];
    skipped: SkippedFolder[];
};

/** The same discovery for a project with no bundler to glob for it. */
export async function discoverFrom(folder: string): Promise<DiscoveryResult>
{
    const entries = await readdir(folder, { withFileTypes: true });
    const plugins: Plugin[] = [];
    const skipped: SkippedFolder[] = [];

    for (const entry of entries)
    {
        if (!entry.isDirectory())
        {
            continue;
        }

        const contract = join(folder, entry.name, "plugin.ts");

        try
        {
            await access(contract);
        }
        catch
        {
            skipped.push({ folder: entry.name, why: "holds no plugin.ts" });

            continue;
        }

        try
        {
            const module = (await import(pathToFileURL(contract).href)) as { default?: Plugin };

            if (module.default === undefined)
            {
                skipped.push({ folder: entry.name, why: "plugin.ts default-exports nothing" });

                continue;
            }

            plugins.push(module.default);
        }
        catch (cause)
        {
            skipped.push({ folder: entry.name, why: cause instanceof Error ? cause.message : String(cause) });
        }
    }

    return {
        plugins: plugins.sort((first, second) => first.name.localeCompare(second.name)),
        skipped: skipped.sort((first, second) => first.folder.localeCompare(second.folder)),
    };
}
