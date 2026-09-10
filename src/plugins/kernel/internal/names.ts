import { KernelFault } from "./faults";

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/;

const NAMESPACED_NAME = /^[a-z][a-z0-9-]{0,63}(\.[a-z][a-z0-9-]{0,63})+$/;

/**
 * Names the character that broke a name, so an author sees the typo rather
 * than a regular expression.
 */
function whereItBroke(value: string): string
{
    const badAt = [...value].findIndex((character) => !/[a-z0-9.-]/.test(character));

    return badAt === -1 ? `"${value}"` : `"${value}" (unsupported character at position ${badAt + 1}: "${value[badAt]}")`;
}

/** A plugin name: lowercase, digits and hyphens, starting with a letter. */
export function pluginName(value: string): string
{
    if (!PLUGIN_NAME.test(value))
    {
        throw new KernelFault(
            "INVALID_NAME",
            `A plugin name is lowercase letters, digits and hyphens, starting with a letter, up to 64 characters. Received ${whereItBroke(value)}.`,
            { detail: { received: value } },
        );
    }

    return value;
}

/** A namespaced name, owned by the plugin its first segment names. */
export function namespacedName(value: string, kind: string, owner: string): string
{
    if (!NAMESPACED_NAME.test(value))
    {
        throw new KernelFault(
            "INVALID_NAME",
            `A ${kind} name is dot-separated lowercase segments, such as "${owner}.thing". Received ${whereItBroke(value)}.`,
            { plugin: owner, detail: { received: value, kind } },
        );
    }

    if (!value.startsWith(`${owner}.`))
    {
        throw new KernelFault(
            "INVALID_NAME",
            `A ${kind} is named inside its own plugin: "${value}" belongs to "${value.split(".")[0] ?? ""}", not to "${owner}". Rename it to "${owner}.${value.split(".").slice(1).join(".")}".`,
            { plugin: owner, detail: { received: value, kind, owner } },
        );
    }

    return value;
}

/** Who owns a namespaced name. */
export function ownerOf(value: string): string
{
    return value.split(".")[0] ?? "";
}
