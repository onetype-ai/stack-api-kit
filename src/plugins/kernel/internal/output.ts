import type { z } from "zod";

/** Whether a schema can be trusted to whitelist what leaves. */
export function isFilterable(schema: z.ZodType): boolean
{
    return isStrictObject(schema, 0, new Set());
}

const OPEN_KINDS: ReadonlySet<string> = new Set(["any", "unknown", "record", "map", "custom", "never", "void", "transform", "pipe", "promise", "function", "file", "symbol"]);

/** What kind of schema this is, or "" for anything unreadable. */
function schemaKind(schema: unknown): string
{
    if (schema === null || typeof schema !== "object")
    {
        return "";
    }

    return String((schema as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type ?? "");
}

function isStrictObject(schema: unknown, depth: number, seen: Set<unknown>): boolean
{
    if (depth > 24 || schema === null || typeof schema !== "object")
    {
        return false;
    }

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

    if (OPEN_KINDS.has(kind))
    {
        return false;
    }

    switch (kind)
    {
        case "object":
        {
            const catchall = def["catchall"];

            if (catchall !== undefined && schemaKind(catchall) !== "never")
            {
                return false;
            }

            const shape = def["shape"];

            if (shape === null || typeof shape !== "object")
            {
                return false;
            }

            return Object.values(shape as Record<string, unknown>).every((field) => isStrictObject(field, depth + 1, seen));
        }

        case "array":
        case "set":
        {
            return isStrictObject(def["element"], depth + 1, seen);
        }

        case "tuple":
        {
            const items = Array.isArray(def["items"]) ? (def["items"] as unknown[]) : [];

            return items.every((member) => isStrictObject(member, depth + 1, seen)) && def["rest"] === undefined;
        }

        case "union":
        {
            const options = Array.isArray(def["options"]) ? (def["options"] as unknown[]) : [];

            return options.length > 0 && options.every((option) => isStrictObject(option, depth + 1, seen));
        }

        case "intersection":
        {
            return isStrictObject(def["left"], depth + 1, seen) && isStrictObject(def["right"], depth + 1, seen);
        }

        case "optional":
        case "nullable":
        case "default":
        case "prefault":
        case "readonly":
        case "nonoptional":
        case "catch":
        {
            return isStrictObject(def["innerType"], depth + 1, seen);
        }

        case "lazy":
        {
            const getter = def["getter"];

            if (typeof getter !== "function")
            {
                return false;
            }

            try
            {
                return isStrictObject((getter as () => unknown)(), depth + 1, seen);
            }
            catch
            {
                return false;
            }
        }

        default:
        {
            return true;
        }
    }
}

/** Number fields a schema names, and whether each carries a range. */
export function numberRanges(schema: unknown): ReadonlyMap<string, boolean>
{
    const ranges = new Map<string, boolean>();

    collectSchemaKeys(schema, ranges, 0, new Set());

    return ranges;
}

function collectSchemaKeys(schema: unknown, ranges: Map<string, boolean>, depth: number, seen: Set<unknown>): void
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
                const inner = stripUnknownKeys(field);
                const innerDef = (inner as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;

                if (String(innerDef?.["type"] ?? "") === "number" && !ranges.has(key))
                {
                    ranges.set(key, hasNumberRange(innerDef?.["checks"]));
                }

                collectSchemaKeys(inner, ranges, depth + 1, seen);
            }
        }
    }

    for (const key of ["innerType", "element", "valueType", "keyType", "left", "right"])
    {
        collectSchemaKeys(def[key], ranges, depth + 1, seen);
    }

    for (const member of Array.isArray(def["options"]) ? (def["options"] as unknown[]) : [])
    {
        collectSchemaKeys(member, ranges, depth + 1, seen);
    }
}

/** Past optional, nullable, default and readonly to what actually holds the value. */
function stripUnknownKeys(schema: unknown): unknown
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
function hasNumberRange(checks: unknown): boolean
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
