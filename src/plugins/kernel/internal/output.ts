import type { z } from "zod";

/**
 * Whether a schema can be trusted to whitelist what leaves.
 *
 * `safeParse` only strips what a schema does not name when the schema is an
 * object that refuses unknown keys. Everything else forwards whatever the
 * handler returned: `z.any()`, `z.unknown()`, a loose object, a catchall, a
 * record, a transform. Each of those parses a row carrying a password hash
 * without complaint and sends it.
 *
 * So the shape is checked once, at startup, rather than trusted per request.
 * A route whose output cannot filter is a route that will leak the first time
 * someone adds a column.
 */
export function filters(schema: z.ZodType): boolean
{
    return whitelists(schema, 0, new Set());
}

const OPEN: ReadonlySet<string> = new Set(["any", "unknown", "record", "map", "custom", "never", "void", "transform", "pipe", "promise", "function", "file", "symbol"]);

/** What kind of schema this is, or "" for anything unreadable. */
function kindOf(schema: unknown): string
{
    if (schema === null || typeof schema !== "object")
    {
        return "";
    }

    return String((schema as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type ?? "");
}

function whitelists(schema: unknown, depth: number, seen: Set<unknown>): boolean
{
    // A schema deep enough to exhaust this is one nobody reviews anyway.
    if (depth > 24 || schema === null || typeof schema !== "object")
    {
        return false;
    }

    // A recursive schema reaches itself. Having judged it once is the answer:
    // whatever it holds has already been walked, and walking again never
    // returns.
    if (seen.has(schema))
    {
        return true;
    }

    seen.add(schema);

    const zod = schema as { _zod?: { def?: Record<string, unknown> } };
    const def = zod._zod?.def;

    if (def === undefined)
    {
        return false;
    }

    const kind = String(def["type"] ?? "");

    if (OPEN.has(kind))
    {
        return false;
    }

    switch (kind)
    {
        case "object":
        {
            // A loose object keeps unknown keys, and a catchall names a type
            // for them: both forward what the handler happened to return.
            //
            // `z.strictObject` is the exception: its catchall is `never`, so
            // it keeps nothing. It refuses the whole answer instead of
            // stripping, which turns a new column into a 500 rather than a
            // leak, so it is safe here and a poor choice anyway.
            const catchall = def["catchall"];

            if (catchall !== undefined && kindOf(catchall) !== "never")
            {
                return false;
            }

            const shape = def["shape"];

            if (shape === null || typeof shape !== "object")
            {
                return false;
            }

            return Object.values(shape as Record<string, unknown>).every((field) => whitelists(field, depth + 1, seen));
        }

        case "array":
        case "set":
        {
            return whitelists(def["element"], depth + 1, seen);
        }

        case "tuple":
        {
            const items = Array.isArray(def["items"]) ? (def["items"] as unknown[]) : [];

            return items.every((item) => whitelists(item, depth + 1, seen)) && def["rest"] === undefined;
        }

        case "union":
        {
            const options = Array.isArray(def["options"]) ? (def["options"] as unknown[]) : [];

            return options.length > 0 && options.every((option) => whitelists(option, depth + 1, seen));
        }

        case "intersection":
        {
            return whitelists(def["left"], depth + 1, seen) && whitelists(def["right"], depth + 1, seen);
        }

        case "optional":
        case "nullable":
        case "default":
        case "prefault":
        case "readonly":
        case "nonoptional":
        case "catch":
        {
            return whitelists(def["innerType"], depth + 1, seen);
        }

        // A recursive shape: the schema is behind a getter, so it has to be
        // called. Depth stops the walk before the recursion does, and a tree
        // that deep is one nobody reviews anyway.
        case "lazy":
        {
            const getter = def["getter"];

            if (typeof getter !== "function")
            {
                return false;
            }

            try
            {
                return whitelists((getter as () => unknown)(), depth + 1, seen);
            }
            catch
            {
                return false;
            }
        }

        // A leaf: it carries its own value and nothing of the caller's shape.
        default:
        {
            return true;
        }
    }
}
