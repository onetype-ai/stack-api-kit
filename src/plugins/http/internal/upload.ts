/** One file a caller sent, as a route sees it. */
export type UploadedFile = {
    /** The filename the caller claimed, with any path stripped. */
    name: string;

    /** The content type the caller claimed. */
    type: string;

    bytes: Uint8Array;
};

/** What a schema names a file field as, so `z.custom` can check it. */
export function isUploadedFile(value: unknown): value is UploadedFile
{
    return value !== null
        && typeof value === "object"
        && typeof (value as UploadedFile).name === "string"
        && typeof (value as UploadedFile).type === "string"
        && (value as UploadedFile).bytes instanceof Uint8Array;
}

/** The last segment of a claimed filename, and nothing that walks anywhere. */
export function claimedName(name: string): string
{
    // Normalise before splitting, never after: U+FF0F is not a separator here
    // but becomes one under NFKC, so a name split first walked out of the
    // upload folder the moment anything downstream normalised it.
    const settled = name.normalize("NFKC");
    const last = settled.split(/[/\\]/u).pop() ?? "";

    // A NUL truncates the name at whatever writes it, so "shell.php\0.png"
    // passes a check for ".png" and lands on disk as shell.php. Control
    // characters and the bidi overrides that disguise an extension go too.
    const clean = last
        .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")

        // Windows drops a trailing dot or space when it writes, so
        // "shell.php." arrives as a name and lands as shell.php
        .replace(/[. ]+$/u, "")
        .slice(0, 255);

    // CON and LPT1 name a device rather than a file on Windows, whatever follows
    const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(clean);

    return clean === "." || clean === ".." || device ? "" : clean;
}

export type FormBody = {
    fields: Record<string, unknown>;
    uploads: Record<string, UploadedFile | UploadedFile[]>;
};

/** A multipart body, read by the platform rather than a parser of ours. */
export async function formBody(request: Request): Promise<FormBody>
{
    const form = await request.formData();
    const fields: Record<string, unknown> = {};
    const uploads: Record<string, UploadedFile | UploadedFile[]> = {};

    for (const [key, part] of form.entries())
    {
        if (typeof part === "string")
        {
            addField(fields, key, part);

            continue;
        }

        addField(uploads, key, {
            name: claimedName(part.name),
            type: part.type,
            bytes: new Uint8Array(await part.arrayBuffer()),
        });
    }

    return { fields, uploads };
}

function addField<Value>(into: Record<string, Value | Value[]>, key: string, value: Value): void
{
    const existing = into[key];

    if (existing === undefined)
    {
        into[key] = value;

        return;
    }

    into[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
}
