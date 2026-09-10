import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

export type OversizedDoc = {
    path: string;
    size: number;
};

export type UndocumentedKey = {
    key: string;
};

const LIMIT = 1800;

/** Folders a project holds but did not write. */
const NOT_OURS = ["node_modules", "dist", ".git", "coverage"];

export function findOversizedDocs(root: string, limit: number = LIMIT): OversizedDoc[]
{
    if (!existsSync(root))
    {
        return [];
    }

    return readdirSync(root, { withFileTypes: true, recursive: true })
        .filter((entry) =>
        {
            if (!entry.isFile() || !entry.name.endsWith(".md") || entry.parentPath.includes("progress"))
            {
                return false;
            }

            return !NOT_OURS.some((folder) => entry.parentPath.split(sep).includes(folder));
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

export function findMissingDocs(root: string, required: readonly string[]): string[]
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

/** Plugins that describe themselves nowhere. */
export function findUnexplainedPlugins(folder: string): string[]
{
    if (!existsSync(folder))
    {
        return [];
    }

    return readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) =>
        {
            try
            {
                return readFileSync(join(folder, name, "usage.md"), "utf8").trim().length === 0;
            }
            catch
            {
                return true;
            }
        });
}

export function findUndocumentedKeys(contractPath: string, procedurePath: string): string[]
{
    const shape = /export type Definition[\s\S]*?\n\};/.exec(contractPath)?.[0] ?? "";
    const keys = [...shape.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((match) =>
    {
        return match[1] ?? "";
    });

    return keys.filter((key) =>
    {
        return !procedurePath.includes(`\`${key}\``);
    });
}
