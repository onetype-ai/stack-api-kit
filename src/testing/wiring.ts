import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type UnusedField = {
    file: string;
    shape: string;
    field: string;
};

/** Fields a contract declares that nothing in production reads. */
export function findUnusedFields(root: string, separately = true): UnusedField[]
{
    const sources = walkFiles(root)
        .filter((file) => !isTestFile(file))
        .map((file): [string, string] => [file, withoutComments(readFileSync(file, "utf8"))]);

    const unread: UnusedField[] = [];

    for (const [file, source] of sources)
    {
        const owns = separately ? otherSources(sources, file) : sources;

        for (const { shape, field } of declaredFields(source))
        {
            if (!isFieldRead(field, owns, file))
            {
                unread.push({ file: relative(root, file), shape, field });
            }
        }
    }

    return unread;
}

/** The files of the plugin a file belongs to, and no others. */
function otherSources(sources: readonly [string, string][], file: string): [string, string][]
{
    const pluginsFolder = file.lastIndexOf("/src/plugins/");

    if (pluginsFolder === -1)
    {
        return [...sources];
    }

    const plugin = file.slice(0, file.indexOf("/", pluginsFolder + "/src/plugins/".length) + 1);

    return sources.filter(([one]) => one.startsWith(plugin));
}

/** Whether a file is a test rather than the code a contract is honoured by. */
function isTestFile(file: string): boolean
{
    return /(^|\/)tests?\//.test(file) || /\.test\.tsx?$/.test(file);
}

/** The source with comments removed. */
function withoutComments(source: string): string
{
    return source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walkFiles(path: string): string[]
{
    if (!existsSync(path))
    {
        return [];
    }

    const paths: string[] = [];

    for (const entry of readdirSync(path))
    {
        const full = join(path, entry);

        if (statSync(full).isDirectory())
        {
            paths.push(...walkFiles(full));
            continue;
        }

        if (/\.tsx?$/.test(entry))
        {
            paths.push(full);
        }
    }

    return paths;
}

function declaredFields(source: string): { shape: string; field: string }[]
{
    const fields: { shape: string; field: string }[] = [];

    for (const shape of source.matchAll(/export\s+(?:type\s+(\w+)\s*=\s*\{|interface\s+(\w+)[^{]*\{)/g))
    {
        const name = shape[1] ?? shape[2] ?? "";
        const from = (shape.index ?? 0) + shape[0].length;
        const body = withoutParameters(source.slice(from, closingBrace(source, from)));

        for (const field of body.matchAll(/(?:^|[;,{\n])\s*(?:readonly\s+)?(\w+)\s*\??\s*:/g))
        {
            fields.push({ shape: name, field: field[1] ?? "" });
        }
    }

    return fields;
}

function closingBrace(source: string, from: number): number
{
    let depth = 1;
    let cursor = from;

    while (cursor < source.length && depth > 0)
    {
        if (source[cursor] === "{")
        {
            depth += 1;
        }

        if (source[cursor] === "}")
        {
            depth -= 1;
        }

        cursor += 1;
    }

    return cursor - 1;
}

function withoutParameters(body: string): string
{
    let outside = "";
    let depth = 0;

    for (const character of body)
    {
        if (character === "(")
        {
            depth += 1;
        }

        if (depth === 0)
        {
            outside += character;
        }

        if (character === ")")
        {
            depth = Math.max(0, depth - 1);
        }
    }

    return outside;
}

function isFieldRead(field: string, sources: readonly [string, string][], where: string): boolean
{
    const patterns = [
        new RegExp(`\\.${field}\\b`),
        new RegExp(`\\b${field}\\s*[,}]`),
        new RegExp(`\\b${field}\\s*:`),
        new RegExp(`\\[["']${field}["']\\]`),
        new RegExp(`["']${field}["']`),
    ];

    return sources.some(([file, source]) =>
    {
        const searched = file === where ? withoutShapes(source) : source;

        return patterns.some((pattern) => pattern.test(searched));
    });
}

function withoutShapes(source: string): string
{
    let body = "";
    let cursor = 0;

    for (const shape of source.matchAll(/export\s+(?:type\s+\w+\s*=\s*|interface\s+\w+[^{]*)\{/g))
    {
        const from = (shape.index ?? 0) + shape[0].length;

        body += source.slice(cursor, shape.index);
        cursor = closingBrace(source, from) + 1;
    }

    return body + source.slice(cursor);
}
