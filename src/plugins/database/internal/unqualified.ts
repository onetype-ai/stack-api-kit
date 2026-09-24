const PUBLIC = "\"public\".";

/**
 * A Postgres script with every `"public".` prefix taken off its identifiers, so its tables resolve through the
 * connection's search_path: drizzle-kit writes `REFERENCES "public"."x"`, which fails in a store kept in a schema of
 * its own. Quoted text, dollar-quoted bodies and comments are copied as they are: a prefix there is data.
 */
export function unqualified(script: string): string
{
    let out = "";
    let at = 0;

    while (at < script.length)
    {
        const rest = script.slice(at);

        if (rest.startsWith(PUBLIC))
        {
            at += PUBLIC.length;

            continue;
        }

        const skipped = skippedLength(script, at);

        out += script.slice(at, at + skipped);
        at += skipped;
    }

    return out;
}

/** How much of the script from `at` is one piece copied untouched: a literal, a comment, a quoted name, or one character. */
function skippedLength(script: string, at: number): number
{
    const char = script[at];
    const next = script[at + 1];

    if (char === "'")
    {
        let end = at + 1;

        // '' is a quote inside the literal, not its end
        while (end < script.length && !(script[end] === "'" && script[end + 1] !== "'"))
        {
            end += script[end] === "'" ? 2 : 1;
        }

        return end + 1 - at;
    }

    if (char === "-" && next === "-")
    {
        const end = script.indexOf("\n", at);

        return (end === -1 ? script.length : end) - at;
    }

    if (char === "/" && next === "*")
    {
        const end = script.indexOf("*/", at + 2);

        return (end === -1 ? script.length : end + 2) - at;
    }

    if (char === "$")
    {
        const tag = /^\$[A-Za-z_]*\$/u.exec(script.slice(at))?.[0];

        if (tag !== undefined)
        {
            const end = script.indexOf(tag, at + tag.length);

            return (end === -1 ? script.length : end + tag.length) - at;
        }
    }

    if (char === "\"")
    {
        const end = script.indexOf("\"", at + 1);

        return (end === -1 ? script.length : end + 1) - at;
    }

    return 1;
}
