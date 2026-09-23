import { z } from "zod";

import type { AnyRoute, Context, Registry } from "./contract";

/** What a registry's change event carries: permission names and where, never the entry itself. */
export const RegistryChange = z.object({
    op: z.enum(["set", "remove"]),
    key: z.string().min(1),
    version: z.number().int().positive(),
    scope: z.string().min(1),
    requires: z.array(z.string()),
    before: z.array(z.string()).optional(),
}).strict();

/** The most entries a snapshot answers when the registry names no cap. */
const MOST_ENTRIES = 256;

/** The kit's route serving an exposed registry: what this caller may see, in its scope, with the version to follow pushes from. */
export function registryRoute(name: string, registry: Registry, limited: boolean): AnyRoute<Context>
{
    const most = registry.cap ?? MOST_ENTRIES;

    return {
        method: "GET",
        path: `/registries/${name}`,
        describe: `Serves registry "${name}" to the app: its entries this caller may see, and their version.`,
        requires: registry.expose?.requires ?? [],
        input: z.object({}),
        output: z.object({ version: z.number().int().nonnegative(), entries: z.array(z.unknown()) }),
        ...(limited && { limit: { requests: 60, seconds: 60 } }),

        handle: async (_input: never, ctx: Context) =>
        {
            const { version, entries } = registry.scope === "tenant"
                ? await ctx.scopedRegistry(name).snapshot()
                : { version: 0, entries: ctx.registry(name).list() };

            return { version, entries: entries.slice(0, most) };
        },
    };
}
