/**
 * One file a caller sent, as a route sees it.
 *
 * `name` and `type` are what the caller wrote, never what the bytes are: a
 * name is a claim, and one claiming `../../etc/passwd` parses exactly as
 * cleanly as `photo.png`. Store under an id you made, and read the type from
 * the bytes if it matters.
 */
export type Upload = {
    /** The filename the caller claimed, with any path stripped. */
    name: string;

    /** The content type the caller claimed. */
    type: string;

    bytes: Uint8Array;
};

/** What a schema names a file field as, so `z.custom` can check it. */
export function isUpload(value: unknown): value is Upload
{
    return value !== null
        && typeof value === "object"
        && typeof (value as Upload).name === "string"
        && typeof (value as Upload).type === "string"
        && (value as Upload).bytes instanceof Uint8Array;
}

/**
 * The last segment of a claimed filename, and nothing that walks anywhere.
 *
 * Both separators, because a caller is not obliged to use the server's. What
 * is left cannot escape a directory, which is the only thing this promises:
 * it is still the caller's word, so it still never names a path you build.
 */
export function claimedName(given: string): string
{
    const last = given.split(/[/\\]/u).pop() ?? "";

    return last === "." || last === ".." ? "" : last;
}

export type FormBody = {
    fields: Record<string, unknown>;
    uploads: Record<string, Upload | Upload[]>;
};

/**
 * A multipart body, read by the platform rather than a parser of ours.
 *
 * `Request.formData` is in every runtime the kit runs on, so what would be a
 * parser here is a call. Text parts become fields a schema reads like any
 * other; file parts become `Upload`s under their own names.
 *
 * A part repeated under one name is an array, the same way a query parameter
 * is: a form with two `photos` means two, not the last one.
 */
export async function formBody(request: Request): Promise<FormBody>
{
    const form = await request.formData();
    const fields: Record<string, unknown> = {};
    const uploads: Record<string, Upload | Upload[]> = {};

    for (const [key, part] of form.entries())
    {
        if (typeof part === "string")
        {
            add(fields, key, part);

            continue;
        }

        add(uploads, key, {
            name: claimedName(part.name),
            type: part.type,
            bytes: new Uint8Array(await part.arrayBuffer()),
        });
    }

    return { fields, uploads };
}

function add<Held>(into: Record<string, Held | Held[]>, key: string, value: Held): void
{
    const already = into[key];

    if (already === undefined)
    {
        into[key] = value;

        return;
    }

    into[key] = Array.isArray(already) ? [...already, value] : [already, value];
}
