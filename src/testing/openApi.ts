import { KernelFault } from "../plugins/kernel/api";

import { startTestKernel } from "./startTestKernel";
import { testClock } from "./testClock";

import type { HttpMethod, Identity, KernelResponse, Plugin } from "../plugins/kernel/api";
import type { TestKernel, TestKernelOptions } from "./startTestKernel";
import type { TestClock } from "./testClock";

export type OpenApiOptions = Omit<TestKernelOptions, "now"> & {
    /** Plugins standing in for real ones, by the name they stand in for: a fake mail sender for "mail". */
    stands?: Readonly<Record<string, Plugin>>;

    /** The clock every plugin reads; one starting now, moving only when told, when left out. */
    clock?: TestClock;

    /** Writes what every test in the file starts from, once the kernel runs: the project's own fixture. */
    seed?: (api: TestKernel) => void | Promise<void>;
};

export type OpenedApi = {
    api: TestKernel;
    clock: TestClock;

    /** Calls a route as `identity`, or signed out when it is undefined, and answers what the kernel answered. */
    call: (identity: Identity | undefined, method: HttpMethod, path: string, input?: unknown) => Promise<KernelResponse>;
};

/** A stand-in answers to the name it replaces, and for something a plugin here depends on, or it stands in for nothing. */
function refuseStrayStands(plugins: readonly Plugin[], stands: Readonly<Record<string, Plugin>>): void
{
    const given = new Set(plugins.map((plugin) => plugin.name));
    const needed = new Set(plugins.flatMap((plugin) => plugin.definition.dependsOn ?? []));

    for (const [name, stand] of Object.entries(stands))
    {
        if (stand.name !== name)
        {
            throw new KernelFault("INVALID_CONFIG", `openApi was given stands["${name}"], a plugin named "${stand.name}". A stand-in carries the name it replaces: definePlugin("${name}", ...).`, { plugin: name });
        }

        if (given.has(name))
        {
            throw new KernelFault("INVALID_CONFIG", `openApi was given "${name}" both in plugins and in stands. Pass the real one or the stand-in, not both.`, { plugin: name });
        }

        if (!needed.has(name))
        {
            throw new KernelFault("INVALID_CONFIG", `openApi was given a stand-in for "${name}", which no plugin here depends on, so it stands in for nothing. Remove it, or pass the plugin that needs it.`, { plugin: name });
        }
    }
}

/** Boots a test kernel with stand-ins, a clock a test moves and a seed, and answers a way to call it as someone. The API twin of the app kit's `openApp`. */
export async function openApi({ stands = {}, clock = testClock(), seed, plugins, ...rest }: OpenApiOptions): Promise<OpenedApi>
{
    refuseStrayStands(plugins, stands);

    const api = await startTestKernel({ ...rest, plugins: [...plugins, ...Object.values(stands)], now: clock.now });

    try
    {
        await seed?.(api);
        await api.flush();
    }
    catch (cause)
    {
        await api.stop();

        throw cause;
    }

    return {
        api,
        clock,
        call: (identity, method, path, input = {}) => api.kernel.handle({ method, path, input, identity }),
    };
}
