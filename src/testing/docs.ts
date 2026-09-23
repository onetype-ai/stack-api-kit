import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";

function entriesOf(folder: string, recursive = false): Dirent[]
{
    if (!existsSync(folder))
    {
        return [];
    }

    return readdirSync(folder, { withFileTypes: true, recursive });
}


/** One markdown file over the limit, `size` measured in characters of its whole text rather than lines or bytes. */
export type OversizedDoc = {
    path: string;
    size: number;
};

/** One contract key a procedure never documents; exported for naming only, since `findUndocumentedKeys` answers plain strings. */
export type UndocumentedKey = {
    key: string;
};

const LIMIT = 1800;

/** Folders a project holds but did not write. */
const NOT_OURS = ["node_modules", "dist", ".git", "coverage"];

/** Walks every `.md` under `root` and answers those longer than `limit` characters (1800 by default), skipping `node_modules`, `dist`, `.git`, `coverage` and anything under a `progress` folder. */
export function findOversizedDocs(root: string, limit: number = LIMIT): OversizedDoc[]
{
    if (!existsSync(root))
    {
        return [];
    }

    return entriesOf(root, true)
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

/** Answers which of the `required` paths, read relative to `root`, are absent or hold nothing but whitespace; a file that exists but is empty counts as missing. */
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

    return entriesOf(folder)
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

/** Keys a minor release added: a procedure written for the release before cannot name them, so they are asked for from the next major on. */
const ADDED_SINCE_MAJOR: ReadonlySet<string> = new Set(["watchesWork", "fake"]);

/** Takes the two files' TEXT, not their paths, and answers the keys of `Definition` that the procedure never names in backticks. */
export function findUndocumentedKeys(contract: string, procedure: string): string[]
{
    const shape = /export type Definition[\s\S]*?\n\};/.exec(contract)?.[0] ?? "";
    const keys = [...shape.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((match) =>
    {
        return match[1] ?? "";
    });

    return keys.filter((key) =>
    {
        return !ADDED_SINCE_MAJOR.has(key) && !procedure.includes(`\`${key}\``);
    });
}
