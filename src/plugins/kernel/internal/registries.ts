import type { Registry } from "./contract";
import { KernelFault } from "./faults";

/** One entry in a registry, and the plugin that added it. */
export type RegistryEntry = Readonly<Record<string, unknown>> & {
    readonly order?: number | undefined;
    readonly requires?: readonly string[] | undefined;
};

type Held = { plugin: string; entry: RegistryEntry };

type Opened = {
    owner: string;
    registry: Registry;
    held: Map<string, Held>;
    listed: readonly RegistryEntry[] | undefined;
};

function byOrderThenKey(key: string)
{
    return (first: Held, second: Held): number =>
    {
        const ordered = (first.entry.order ?? 0) - (second.entry.order ?? 0);

        return ordered !== 0 ? ordered : String(first.entry[key]).localeCompare(String(second.entry[key]));
    };
}

export function registries(warn: (plugin: string, line: string, about: Readonly<Record<string, unknown>>) => void)
{
    const opened = new Map<string, Opened>();

    function refuse(name: string, plugin: string, message: string): never
    {
        throw new KernelFault("INVALID_ENTRY", `Registry "${name}" refused an entry from "${plugin}": ${message}`, { plugin });
    }

    function changed(one: Opened): void
    {
        one.listed = undefined;
    }

    return {
        declare: (owner: string, name: string, registry: Registry): void =>
        {
            opened.set(name, { owner, registry, held: new Map(), listed: undefined });
        },

        known: (name: string): boolean =>
        {
            return opened.has(name);
        },

        ownerOf: (name: string): string | undefined =>
        {
            return opened.get(name)?.owner;
        },

        add: (plugin: string, name: string, candidate: unknown): (() => void) =>
        {
            const one = opened.get(name);

            if (one === undefined)
            {
                throw new KernelFault("UNDECLARED_REGISTRY", `"${plugin}" added to registry "${name}", which no plugin declares. Declare it, or correct the name.`, { plugin });
            }

            const { registry, owner } = one;

            if (registry.set === "owner" && plugin !== owner)
            {
                refuse(name, plugin, `only "${owner}" may add to it.`);
            }

            const answer = registry.entry.safeParse(candidate);

            if (!answer.success)
            {
                refuse(name, plugin, `it does not match the entry schema: ${answer.error.issues[0]?.message ?? "it was rejected"}.`);
            }

            const entry = Object.freeze({ ...(answer.data as RegistryEntry) });
            const key = entry[registry.key];

            if (typeof key !== "string" || key === "")
            {
                refuse(name, plugin, `its "${registry.key}" must be a non-empty string, since that is the registry's key.`);
            }

            if (plugin !== owner && (registry.reserved ?? []).includes(key))
            {
                refuse(name, plugin, `"${key}" is reserved by "${owner}". Pick another ${registry.key}.`);
            }

            const before = one.held.get(key);

            if (before !== undefined && (registry.replace ?? "refuse") === "refuse")
            {
                refuse(name, plugin, `"${key}" is already added by "${before.plugin}". Pick another ${registry.key}, or have "${owner}" declare replace: "warn".`);
            }

            if (before === undefined && registry.cap !== undefined && one.held.size >= registry.cap)
            {
                refuse(name, plugin, `it holds its most, ${registry.cap} entries. Remove one first.`);
            }

            if (before !== undefined)
            {
                warn(plugin, `registry "${name}" replaced "${key}", added by "${before.plugin}"`, { registry: name, key });
            }

            const held: Held = { plugin, entry };

            one.held.set(key, held);
            changed(one);

            return () =>
            {
                // a later add under the same key owns it now; this stop must not take that one out
                if (one.held.get(key) === held)
                {
                    one.held.delete(key);
                    changed(one);
                }
            };
        },

        list: (name: string): readonly RegistryEntry[] =>
        {
            const one = opened.get(name);

            if (one === undefined)
            {
                throw new KernelFault("UNDECLARED_REGISTRY", `Registry "${name}" is not declared by any plugin.`);
            }

            one.listed ??= Object.freeze([...one.held.values()].sort(byOrderThenKey(one.registry.key)).map((held) => held.entry));

            return one.listed;
        },

        // a stopped kernel that starts again must not hold an entry twice
        reset: (): void =>
        {
            opened.clear();
        },
    };
}
