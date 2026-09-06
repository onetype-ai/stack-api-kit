import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type UnusedField = {
    file: string;
    shape: string;
    field: string;
};

/**
 * Fields a contract declares that nothing in production reads.
 *
 * Tests and comments are excluded from what counts as a read. Counting them
 * is what made this check certify rather than check: a field kept alive by a
 * fixture is a field the document promises and no code honours, which is the
 * defect this exists to catch.
 */
export function findUnusedFields(root: string, apart = true): UnusedField[]
{
    const sources = walk(root)
        .filter((file) => !isTest(file))
        .map((file): [string, string] => [file, withoutComments(readFileSync(file, "utf8"))]);

    const unread: UnusedField[] = [];

    for (const [file, source] of sources)
    {
        // Only the plugin that declared it can read it, so only its files are
        // searched. Searching every plugin makes the check weaker the more
        // plugins there are: a field called `id` or `status` is read
        // somewhere in any codebase, and would be certified everywhere.
        const owns = apart ? within(sources, file) : sources;

        for (const { shape, field } of fieldsIn(source))
        {
            if (!isRead(field, owns, file))
            {
                unread.push({ file: relative(root, file), shape, field });
            }
        }
    }

    return unread;
}

/**
 * The files of the plugin a file belongs to, and no others.
 *
 * A plugin cannot read another's types, so a field read only elsewhere is a
 * field nothing honours. Searching every plugin makes the check weaker the
 * more there are: `id` or `status` occurs somewhere in any codebase, and
 * would be certified everywhere it appears.
 */
function within(sources: readonly [string, string][], file: string): [string, string][]
{
    const at = file.lastIndexOf("/src/plugins/");

    if (at === -1)
    {
        return [...sources];
    }

    const plugin = file.slice(0, file.indexOf("/", at + "/src/plugins/".length) + 1);

    return sources.filter(([one]) => one.startsWith(plugin));
}

/** Whether a file is a test rather than the code a contract is honoured by. */
function isTest(file: string): boolean
{
    return /(^|\/)tests?\//.test(file) || /\.test\.tsx?$/.test(file);
}

/**
 * The source with comments removed.
 *
 * A name mentioned in a comment is a name nothing consumes: "someday we will
 * enforce `limit`" is exactly the shape this check exists to refuse.
 */
function withoutComments(source: string): string
{
    return source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(path: string): string[]
{
    if (!existsSync(path))
    {
        return [];
    }

    const found: string[] = [];

    for (const entry of readdirSync(path))
    {
        const full = join(path, entry);

        if (statSync(full).isDirectory())
        {
            found.push(...walk(full));
            continue;
        }

        if (/\.tsx?$/.test(entry))
        {
            found.push(full);
        }
    }

    return found;
}

// A contract is what crosses a boundary, so only exported shapes count: an
// internal type is read by whoever wrote it or it would not compile.
function fieldsIn(source: string): { shape: string; field: string }[]
{
    const found: { shape: string; field: string }[] = [];

    for (const shape of source.matchAll(/export\s+(?:type\s+(\w+)\s*=\s*\{|interface\s+(\w+)[^{]*\{)/g))
    {
        const name = shape[1] ?? shape[2] ?? "";
        const from = (shape.index ?? 0) + shape[0].length;
        const body = withoutParameters(source.slice(from, closingBrace(source, from)));

        for (const field of body.matchAll(/(?:^|[;,{\n])\s*(?:readonly\s+)?(\w+)\s*\??\s*:/g))
        {
            found.push({ shape: name, field: field[1] ?? "" });
        }
    }

    return found;
}

// Where the brace opened at `from` closes. Walking counts nested shapes as
// part of the same contract; stopping at the first "}" would miss their fields.
function closingBrace(source: string, from: number): number
{
    let depth = 1;
    let at = from;

    while (at < source.length && depth > 0)
    {
        if (source[at] === "{")
        {
            depth += 1;
        }

        if (source[at] === "}")
        {
            depth -= 1;
        }

        at += 1;
    }

    return at - 1;
}

// A parameter inside a function type is not a field: `debug: (line, about?: X)
// => void` declares one name, and "about" is positional. Counting it reports a
// defect where there is none.
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

// Property access, destructuring, an object literal built from it, a string
// key. A name in none of those is a name nothing consumes.
function isRead(field: string, sources: readonly [string, string][], where: string): boolean
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

// The declaration itself is not a read. Shapes are stripped by walking braces,
// never by matching to the next "}": a regex doing that runs past the end of
// the type and swallows the code below it.
function withoutShapes(source: string): string
{
    let body = "";
    let at = 0;

    for (const shape of source.matchAll(/export\s+(?:type\s+\w+\s*=\s*|interface\s+\w+[^{]*)\{/g))
    {
        const from = (shape.index ?? 0) + shape[0].length;

        body += source.slice(at, shape.index);
        at = closingBrace(source, from) + 1;
    }

    return body + source.slice(at);
}
