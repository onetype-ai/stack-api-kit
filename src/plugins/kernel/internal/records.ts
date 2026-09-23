/**
 * A record in an output schema filters only when its keys are a closed or patterned set: a bare
 * string key forwards any key a handler wrote, which is the leak output exists to stop. A key
 * pattern is never judged by its text: it is compiled anchored at both ends, without the flags
 * that loosen anchoring, and must refuse keys no whitelist means to let out.
 */

type Def = Record<string, unknown>;

const MOST_KEY_LENGTH = 64;

/** Keys never sent, whatever the pattern: the empty one, and those reaching an object's prototype. */
const ALWAYS_REFUSED_KEYS = ["", "__proto__", "constructor", "prototype"];

/** Over a bare scalar value the value would be the credential itself, so a pattern letting its name through is refused. */
const CREDENTIAL_KEYS = ["secretHash", "password", "token", "apiKey", "sk_live_AbC123xyz0123456789"];

/** Keys shaped like a secret or a person's address, whatever the value; each carries a separator no identifier holds, so a pattern for property names still boots. */
const SECRET_SHAPED_KEYS = ["a@b.co", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "sk-live-AbC123xyz0123456789", "keys/sk.AbC123"];

const SCALAR_KINDS: ReadonlySet<string> = new Set(["string", "number", "bigint", "boolean", "enum", "literal", "date", "template_literal", "nan"]);

const WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

/** How far pruning walks into a value before leaving the rest to the schema. */
const MOST_PRUNE_DEPTH = 32;

function defOf(schema: unknown): Def | undefined
{
    return (schema as { _zod?: { def?: Def } } | null | undefined)?._zod?.def;
}

function kindOf(def: Def | undefined): string
{
    return String(def?.["type"] ?? "");
}

function isScalar(schema: unknown): boolean
{
    const def = defOf(schema);
    const kind = kindOf(def);

    if (WRAPPERS.has(kind))
    {
        return isScalar(def?.["innerType"]);
    }

    if (kind === "union")
    {
        return ((def?.["options"] ?? []) as unknown[]).some((option) => isScalar(option));
    }

    return SCALAR_KINDS.has(kind);
}

/** Every regex check on a key schema, anchored at both ends and stripped of g, m and y. */
function keyPatterns(schema: unknown): RegExp[]
{
    const checks = (defOf(schema)?.["checks"] ?? []) as { _zod?: { def?: { format?: unknown; pattern?: unknown } } }[];

    return checks
        .map((check) => check._zod?.def)
        .filter((def): def is { format: string; pattern: RegExp } => def?.format === "regex" && def.pattern instanceof RegExp)
        .map((def) => new RegExp(`^(?:${def.pattern.source})$`, def.pattern.flags.replace(/[gmy]/gu, "")));
}

/** Whether a record's key schema names a closed or patterned set a secret-shaped key cannot pass. */
export function isBoundedKey(schema: unknown, valueType: unknown): boolean
{
    const def = defOf(schema);

    switch (kindOf(def))
    {
        case "enum":
        case "literal":
            return true;

        case "union":
        {
            const options = def?.["options"];

            return Array.isArray(options) && options.length > 0 && options.every((option) => isBoundedKey(option, valueType));
        }

        case "string":
        {
            const patterns = keyPatterns(schema);
            const refused = isScalar(valueType) ? [...SECRET_SHAPED_KEYS, ...ALWAYS_REFUSED_KEYS, ...CREDENTIAL_KEYS] : SECRET_SHAPED_KEYS;

            return patterns.length > 0 && refused.every((key) => !patterns.every((pattern) => pattern.test(key)));
        }

        default:
            return false;
    }
}

function isAllowedKey(schema: unknown, key: string): boolean
{
    const parsing = schema as { safeParse?: (value: unknown) => { success: boolean } };

    return !ALWAYS_REFUSED_KEYS.includes(key)
        && key.length <= MOST_KEY_LENGTH
        && parsing.safeParse?.(key).success === true
        && keyPatterns(schema).every((pattern) => pattern.test(key));
}

/**
 * The value with every record key its key schema refuses dropped, before the schema parses it:
 * zod refuses a whole record over one key, where a whitelist leaves that key behind. Objects
 * strip themselves; this walks only far enough to reach the records inside them.
 */
export function pruneRecords(schema: unknown, value: unknown, depth = 0): unknown
{
    const def = defOf(schema);

    if (def === undefined || depth > MOST_PRUNE_DEPTH || value === null || typeof value !== "object")
    {
        return value;
    }

    const kind = kindOf(def);

    if (WRAPPERS.has(kind))
    {
        return pruneRecords(def["innerType"], value, depth + 1);
    }

    switch (kind)
    {
        case "object":
        {
            if (Array.isArray(value))
            {
                return value;
            }

            const shape = (def["shape"] ?? {}) as Record<string, unknown>;

            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Object.hasOwn(shape, key) ? pruneRecords(shape[key], item, depth + 1) : item]));
        }

        case "record":
        {
            if (Array.isArray(value))
            {
                return value;
            }

            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => isAllowedKey(def["keyType"], key))
                .map(([key, item]) => [key, pruneRecords(def["valueType"], item, depth + 1)]));
        }

        case "array":
            return Array.isArray(value) ? value.map((item: unknown) => pruneRecords(def["element"], item, depth + 1)) : value;

        case "lazy":
            return pruneRecords((def["getter"] as () => unknown)(), value, depth + 1);

        default:
            return value;
    }
}
