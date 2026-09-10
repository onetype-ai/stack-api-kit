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
    const last = name.split(/[/\\]/u).pop() ?? "";

    return last === "." || last === ".." ? "" : last;
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
    const already = into[key];

    if (already === undefined)
    {
        into[key] = value;

        return;
    }

    into[key] = Array.isArray(already) ? [...already, value] : [already, value];
}
