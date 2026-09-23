import type { DocumentPolicy, FileType } from "./contract";
import { KernelFault } from "./faults";

/** What a client is told: a status, a stable code, and one sentence. */
export type RefusalBody = {
    status: number;
    code: string;
    message: string;

    /** Field-level detail, only ever from an input schema. */
    fields?: Readonly<Record<string, string>>;
};

/** What a handler returns when the body alone is not the answer. */
export class Reply
{
    readonly status: number;

    readonly body: unknown;

    readonly headers: Readonly<Record<string, string>>;

    constructor(status: number, body: unknown, headers: Readonly<Record<string, string>> = {})
    {
        this.status = status;
        this.body = body;
        this.headers = headers;
    }

    /** What `Reply.events` gave, read by the kit. */
    events?: EventsReply;

    /** What `Reply.document` gave, read by the kit. */
    document?: { policy: DocumentPolicy | undefined; etag: string | undefined };

    /** What `Reply.file` gave, read by the kit. */
    file?: { type: FileType; filename: string; etag: string | undefined };

    /** Sends the caller somewhere else. */
    static redirect(to: string, permanent = false): Reply
    {
        return new Reply(permanent ? 308 : 307, { to }, { location: to });
    }

    /** An HTML page, for a route declaring `document`: its policy and etag, when given, replace the route's; `headers` takes only cache-control, vary and content-language. */
    static document(html: string, options: { policy?: DocumentPolicy; status?: number; etag?: string; headers?: Readonly<Record<string, string>> } = {}): Reply
    {
        const reply = new Reply(options.status ?? 200, html, options.headers ?? {});

        reply.document = { policy: options.policy, etag: options.etag };

        return reply;
    }

    /** A download, for a route declaring `file`: text, bytes, or an iterable of chunks sent as they come; `headers` takes only cache-control and vary. */
    static file(body: string | Uint8Array | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, options: { type: FileType; filename: string; status?: number; etag?: string; headers?: Readonly<Record<string, string>> }): Reply
    {
        const reply = new Reply(options.status ?? 200, body, options.headers ?? {});

        reply.file = { type: options.type, filename: options.filename, etag: options.etag };

        return reply;
    }

    /**
     * A CSV download, for a route declaring `file` with "text/csv": RFC 4180 quoting, one header row from `columns`,
     * and every cell a spreadsheet would run as a formula (starting with =, +, -, @, a tab or a return) kept as text.
     */
    static csv(rows: readonly Readonly<Record<string, unknown>>[], options: { columns: readonly string[]; filename: string }): Reply
    {
        const cell = (value: unknown): string =>
        {
            const text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? String(value) : JSON.stringify(value);
            const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;

            return /[",\r\n;]/u.test(safe) || safe !== text ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
        };

        const lines = [options.columns.map(cell).join(","), ...rows.map((row) => options.columns.map((column) => cell(row[column])).join(","))];

        return Reply.file(`${lines.join("\r\n")}\r\n`, { type: "text/csv", filename: options.filename });
    }

    /**
     * Events, for a route declaring `streams`: `headers` only names the route `sends`, printable, up to 256 characters each;
     * `end` (1 to 64 printable characters) is written raw as the last `data:` line when the events finish, never after a failure;
     * `error`, given the neutral message, becomes the data-only frame an unexpected failure ends the stream with, instead of `event: error`.
     */
    static events(source: Iterable<unknown> | AsyncIterable<unknown>, options: { headers?: Readonly<Record<string, string>>; end?: string; error?: (message: string) => unknown } = {}): Reply
    {
        const reply = new Reply(200, undefined, options.headers ?? {});

        reply.events = { source, end: options.end, error: options.error };

        return reply;
    }
}

/** What a streamed reply carries besides its headers. */
export type EventsReply = {
    source: Iterable<unknown> | AsyncIterable<unknown>;
    end: string | undefined;
    error: ((message: string) => unknown) | undefined;
};

/** One event of a streamed answer: `data` is what the route's `streams` schema parses, `event` and `id` the SSE fields an EventSource reads. */
export class ServerEvent<Data = unknown>
{
    readonly data: Data;

    readonly event: string | undefined;

    readonly id: string | undefined;

    constructor(data: Data, options: { event?: string; id?: string } = {})
    {
        this.data = data;
        this.event = options.event;
        this.id = options.id;
    }
}

/** A refusal a plugin raises on purpose, meant to reach the caller. */
export class Refusal extends Error
{
    readonly status: number;

    readonly code: string;

    readonly fields: Readonly<Record<string, string>> | undefined;

    /** How many seconds the caller should wait before trying again, sent as `retry-after`. */
    readonly retryAfter: number | undefined;

    constructor(status: number, code: string, message: string, fields?: Readonly<Record<string, string>>, options: { retryAfter?: number } = {})
    {
        super(message);

        this.name = "Refusal";
        this.status = status;
        this.code = code;
        this.fields = fields;
        this.retryAfter = options.retryAfter !== undefined && Number.isFinite(options.retryAfter) && options.retryAfter >= 0 ? Math.ceil(options.retryAfter) : undefined;
    }
}

const CLIENT_FAULTS: Readonly<Record<string, { status: number; message: string }>> = {
    UNAUTHENTICATED: { status: 401, message: "This request needs to be signed in." },
    PERMISSION_DENIED: { status: 403, message: "This request is not permitted." },
    RATE_LIMITED: { status: 429, message: "Too many requests. Try again shortly." },
    INVALID_PAYLOAD: { status: 400, message: "The request body is not valid." },

    // a caller the scope cannot place is refused, not a server fault
    UNCLAIMED_SCOPE: { status: 403, message: "This request is not permitted." },
    UNSCOPED_CALLER: { status: 403, message: "This request is not permitted." },
};

/** What the caller is told about a failure. */
export function refusalBodyFor(cause: unknown): RefusalBody
{
    if (cause instanceof Refusal)
    {
        return {
            status: cause.status,
            code: cause.code,
            message: cause.message,
            ...(cause.fields !== undefined && { fields: cause.fields }),
        };
    }

    if (cause instanceof KernelFault)
    {
        const known = CLIENT_FAULTS[cause.code];

        if (known !== undefined)
        {
            return { status: known.status, code: cause.code, message: known.message };
        }
    }

    return { status: 500, code: "INTERNAL", message: "The request could not be completed." };
}

/** Whether a failure is the caller's doing or ours. */
export function isServerError(body: RefusalBody): boolean
{
    return body.status >= 500;
}
