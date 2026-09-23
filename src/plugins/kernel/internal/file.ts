import type { Context, FileType, Route } from "./contract";
import { quotedTag, tagged } from "./document";
import { logRecord } from "./logRecord";
import { Reply } from "./refusal";
import { filterHeaders } from "./replyHeaders";
import type { KernelRequest, KernelResponse } from "./request";

type RequestLog = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;

/** What a download may be sent as: a type a person saves, never one a browser renders and runs. */
export const FILE_TYPES: ReadonlySet<string> = new Set<FileType>(["text/csv", "text/plain", "application/json", "application/pdf", "application/zip", "application/octet-stream"]);

/** The headers a download may choose for itself. */
const FILE_HEADERS: ReadonlySet<string> = new Set(["cache-control", "vary"]);

/**
 * RFC 6266: an ASCII fallback any client reads, and the name as given (RFC 5987) for those that
 * read `filename*`. Cut by code points, so a surrogate pair is never split; controls, format
 * characters (bidi), line separators and path separators never survive either form.
 */
export function dispositionFor(filename: string | undefined): string
{
    const whole = String(filename ?? "download").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD");
    const name = Array.from(whole.replace(/[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_")).slice(0, 200).join("") || "download";
    const fallback = name.normalize("NFKD").replace(/[^\x20-\x7e]/gu, "").replace(/["\\%;]/gu, "_") || "download";
    const encoded = encodeURIComponent(name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Whether a body arrives in chunks rather than whole. */
function isChunked(body: unknown): body is Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>
{
    return body !== null && typeof body === "object" && !(body instanceof Uint8Array) && (Symbol.asyncIterator in body || Symbol.iterator in body);
}

/** Chunks as bytes, the failure of a source that breaks midway logged before it breaks the connection. */
async function* fileChunks(source: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, route: Route<Context>, plugin: string, log: RequestLog): AsyncGenerator<Uint8Array>
{
    const encoder = new TextEncoder();

    try
    {
        for await (const chunk of source)
        {
            yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        }
    }
    catch (cause)
    {
        log("error", plugin, `${route.method} ${route.path} threw while sending a file`, logRecord(cause));

        throw cause;
    }
}

/** A route's answer as a download: always an attachment, of a type the route declared. */
export function fileAnswer(returned: unknown, route: Route<Context> & { file: NonNullable<Route<Context>["file"]> }, plugin: string, log: RequestLog, incoming: KernelRequest): KernelResponse
{
    const failed = (why: string): KernelResponse =>
    {
        log("error", plugin, `${route.method} ${route.path} ${why}`);

        return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
    };

    const reply = returned instanceof Reply ? returned : undefined;

    if (reply?.file === undefined)
    {
        return failed("declares file, and its handle answered no Reply.file");
    }

    if (!route.file.types.includes(reply.file.type))
    {
        return failed(`answered a file of type "${String(reply.file.type)}", which it does not declare in file.types`);
    }

    const body: unknown = reply.body;

    if (typeof body !== "string" && !(body instanceof Uint8Array) && !isChunked(body))
    {
        return failed("answered a file whose body is neither text, bytes nor an iterable of chunks");
    }

    const headers = {
        "cache-control": "no-store",
        ...filterHeaders(reply.headers, plugin, route, log, (name) => FILE_HEADERS.has(name)),
        "content-type": reply.file.type.startsWith("text/") ? `${reply.file.type}; charset=utf-8` : reply.file.type,
        "content-disposition": dispositionFor(reply.file.filename),
        "x-content-type-options": "nosniff",
    };

    if (isChunked(body))
    {
        return { status: reply.status, body: fileChunks(body, route, plugin, log), headers: { ...headers, ...(reply.file.etag !== undefined && { etag: quotedTag(reply.file.etag) }) }, file: true };
    }

    // a whole body is tagged by its text, and sent as it came
    const whole = typeof body === "string" ? body : new TextDecoder().decode(body);
    const answer = tagged({ status: reply.status, body: whole, headers }, route, incoming, reply.file.etag);

    return { ...answer, ...(answer.status !== 304 && { body }), file: true };
}
