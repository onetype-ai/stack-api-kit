import type { UploadedFile } from "./upload";

/** What one request carries, before any schema has looked at it. */
export type RequestInput = {
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string[]>>;
    body: unknown;
    uploads?: Readonly<Record<string, UploadedFile | UploadedFile[]>>;
};

const UNSAFE: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** One object for a route's input schema to judge. */
export function readInput(request: RequestInput): Record<string, unknown>
{
    const merged: Record<string, unknown> = {};

    if (request.body !== null && typeof request.body === "object" && !Array.isArray(request.body))
    {
        for (const [key, value] of Object.entries(request.body as Record<string, unknown>))
        {
            if (UNSAFE.has(key))
            {
                continue;
            }

            merged[key] = value;
        }
    }

    for (const [key, values] of Object.entries(request.query))
    {
        if (UNSAFE.has(key))
        {
            continue;
        }

        merged[key] = values.length === 1 ? values[0] : values;
    }

    for (const [key, value] of Object.entries(request.params))
    {
        if (UNSAFE.has(key))
        {
            continue;
        }

        merged[key] = value;
    }

    for (const [key, upload] of Object.entries(request.uploads ?? {}))
    {
        if (UNSAFE.has(key))
        {
            continue;
        }

        merged[key] = upload;
    }

    return merged;
}
