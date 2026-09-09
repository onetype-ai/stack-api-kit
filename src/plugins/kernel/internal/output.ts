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
export function canFilter(schema: z.ZodType): boolean
{
    return isWhitelist(schema, 0, new Set());
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

function isWhitelist(schema: unknown, depth: number, seen: Set<unknown>): boolean
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

            return Object.values(shape as Record<string, unknown>).every((field) => isWhitelist(field, depth + 1, seen));
        }

        case "array":
        case "set":
        {
            return isWhitelist(def["element"], depth + 1, seen);
        }

        case "tuple":
        {
            const items = Array.isArray(def["items"]) ? (def["items"] as unknown[]) : [];

            return items.every((member) => isWhitelist(member, depth + 1, seen)) && def["rest"] === undefined;
        }

        case "union":
        {
            const options = Array.isArray(def["options"]) ? (def["options"] as unknown[]) : [];

            return options.length > 0 && options.every((option) => isWhitelist(option, depth + 1, seen));
        }

        case "intersection":
        {
            return isWhitelist(def["left"], depth + 1, seen) && isWhitelist(def["right"], depth + 1, seen);
        }

        case "optional":
        case "nullable":
        case "default":
        case "prefault":
        case "readonly":
        case "nonoptional":
        case "catch":
        {
            return isWhitelist(def["innerType"], depth + 1, seen);
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
                return isWhitelist((getter as () => unknown)(), depth + 1, seen);
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

/**
 * Number fields a schema names, and whether each carries a range.
 *
 * A number that crosses a boundary without one says only "number", which
 * tells a consumer nothing: the same field bounded to 0..1 where it enters
 * and bare where it leaves is a promise made and then withdrawn, and the
 * consumer that assumed a share is the one that breaks.
 */
export function rangedNumbers(schema: unknown): ReadonlyMap<string, boolean>
{
    const found = new Map<string, boolean>();

    collect(schema, found, 0, new Set());

    return found;
}

function collect(schema: unknown, found: Map<string, boolean>, depth: number, seen: Set<unknown>): void
{
    if (depth > 24 || schema === null || typeof schema !== "object" || seen.has(schema))
    {
        return;
    }

    seen.add(schema);

    const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;

    if (def === undefined)
    {
        return;
    }

    const kind = String(def["type"] ?? "");

    if (kind === "object")
    {
        const shape = def["shape"];

        if (shape !== null && typeof shape === "object")
        {
            for (const [key, field] of Object.entries(shape as Record<string, unknown>))
            {
                const inner = bare(field);
                const within = (inner as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;

                if (String(within?.["type"] ?? "") === "number" && !found.has(key))
                {
                    found.set(key, ranged(within?.["checks"]));
                }

                collect(inner, found, depth + 1, seen);
            }
        }
    }

    for (const key of ["innerType", "element", "valueType", "keyType", "left", "right"])
    {
        collect(def[key], found, depth + 1, seen);
    }

    for (const member of Array.isArray(def["options"]) ? (def["options"] as unknown[]) : [])
    {
        collect(member, found, depth + 1, seen);
    }
}

/** Past optional, nullable, default and readonly to what actually holds the value. */
function bare(schema: unknown): unknown
{
    let current = schema;

    for (let step = 0; step < 12; step += 1)
    {
        const def = (current as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
        const kind = String(def?.["type"] ?? "");

        if (kind !== "optional" && kind !== "nullable" && kind !== "default" && kind !== "readonly" && kind !== "nonoptional")
        {
            return current;
        }

        current = def?.["innerType"];
    }

    return current;
}

/** Whether any check bounds the value from either side. */
function ranged(checks: unknown): boolean
{
    if (!Array.isArray(checks))
    {
        return false;
    }

    return checks.some((one) =>
    {
        const def = (one as { _zod?: { def?: { check?: unknown } }; def?: { check?: unknown } })._zod?.def ?? (one as { def?: { check?: unknown } }).def;
        const name = String(def?.check ?? "");

        return name === "greater_than" || name === "less_than";
    });
}
