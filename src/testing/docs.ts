import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type OversizedDoc = {
    path: string;
    size: number;
};

export type UndocumentedKey = {
    key: string;
};

const LIMIT = 1800;

// A contract nobody can read in one sitting is a contract nobody reads. What
// grows past this is two documents, or a rule that belongs in code.
export function oversized(root: string, limit: number = LIMIT): OversizedDoc[]
{
    if (!existsSync(root))
    {
        return [];
    }

    return readdirSync(root, { withFileTypes: true, recursive: true })
        .filter((entry) =>
        {
            return entry.isFile() && entry.name.endsWith(".md") && !entry.parentPath.includes("progress");
        })
        .map((entry) =>
        {
            const path = join(entry.parentPath, entry.name);

            return { path, size: readFileSync(path, "utf8").length };
        })
        .filter((doc) =>
        {
            return doc.size > limit;
        });
}

// A document that is present but empty reads as done and says nothing, which
// is worse than one that is missing and obviously so.
export function missing(root: string, required: readonly string[]): string[]
{
    return required.filter((path) =>
    {
        try
        {
            return readFileSync(join(root, path), "utf8").trim().length === 0;
        }
        catch
        {
            return true;
        }
    });
}

/**
 * Plugins that describe themselves nowhere.
 *
 * A plugin is a capability someone else has to understand before they can
 * depend on it, and its contract says what crosses the boundary rather than
 * why anyone would want it. A folder with no `usage.md` is one nobody can
 * decide about without reading its source.
 */
export function unexplained(plugins: string): string[]
{
    if (!existsSync(plugins))
    {
        return [];
    }

    return readdirSync(plugins, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) =>
        {
            try
            {
                return readFileSync(join(plugins, name, "usage.md"), "utf8").trim().length === 0;
            }
            catch
            {
                return true;
            }
        });
}

// Every key the contract accepts is named in the procedure that explains it.
// A key added to one and not the other is how a document starts lying.
export function undocumented(contract: string, procedure: string): string[]
{
    const shape = /export type Definition[\s\S]*?\n\};/.exec(contract)?.[0] ?? "";
    const keys = [...shape.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((match) =>
    {
        return match[1] ?? "";
    });

    return keys.filter((key) =>
    {
        return !procedure.includes(`\`${key}\``);
    });
}
