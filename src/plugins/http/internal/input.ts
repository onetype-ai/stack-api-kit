/** What one request carries, before any schema has looked at it. */
export type Carried = {
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string[]>>;
    body: unknown;
};

const UNSAFE: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * One object for a route's input schema to judge.
 *
 * Path parameters win over query, and query over body, because a path
 * parameter is the one part of a request a router already matched: a body
 * claiming a different `id` than the path it was sent to is either confused
 * or deliberate, and either way the path is the request.
 *
 * Nothing is coerced here. A schema saying a page is a number is the thing
 * that turns "2" into 2, and it is the only thing that should: a converter
 * ahead of the schema decides what "0x10" or "" mean before the schema that
 * owns the field gets a say.
 */
export function input(carried: Carried): Record<string, unknown>
{
    const merged: Record<string, unknown> = {};

    if (carried.body !== null && typeof carried.body === "object" && !Array.isArray(carried.body))
    {
        for (const [key, value] of Object.entries(carried.body as Record<string, unknown>))
        {
            // Prototype pollution: a body naming __proto__ reaches
            // Object.prototype through a plain assignment, and every object
            // in the process changes shape.
            if (UNSAFE.has(key))
            {
                continue;
            }

            merged[key] = value;
        }
    }

    // A query parameter arrives as a list, because a caller may repeat it.
    // One value is handed over as that value: a schema saying `z.string()`
    // could otherwise never match `?q=hello`, which made every query
    // parameter unusable unless its schema expected an array.
    for (const [key, values] of Object.entries(carried.query))
    {
        if (UNSAFE.has(key))
        {
            continue;
        }

        merged[key] = values.length === 1 ? values[0] : values;
    }

    for (const [key, value] of Object.entries(carried.params))
    {
        if (UNSAFE.has(key))
        {
            continue;
        }

        merged[key] = value;
    }

    return merged;
}
