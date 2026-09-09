import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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


/** What discoverFrom leaves behind: a folder it could not take. */
export type Skipped = {
    folder: string;
    why: string;
};

/** What discoverFrom answers: what it found, and what it stepped over. */
export type Found = {
    plugins: Plugin[];
    skipped: Skipped[];
};

/**
 * The same discovery for a project with no bundler to glob for it.
 *
 * A folder that cannot be loaded is one plugin fewer, named, rather than a
 * dead boot. Six finished plugins and one half-written folder is a working
 * api missing one region: refusing the lot means an author cannot see their
 * own screen until everybody else has finished, and the only way out is to
 * move somebody else's folder aside.
 *
 * Nothing hides behind this. A plugin that is skipped is a plugin no other
 * one can name: whoever declares `dependsOn` on it is refused at startup by
 * name, so a missing region is loud wherever it actually matters.
 */
export async function discoverFrom(folder: string): Promise<Found>
{
    const entries = await readdir(folder, { withFileTypes: true });
    const plugins: Plugin[] = [];
    const skipped: Skipped[] = [];

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
