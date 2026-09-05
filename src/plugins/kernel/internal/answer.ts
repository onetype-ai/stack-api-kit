import { KernelFault } from "./faults";

/** What a client is told: a status, a stable code, and one sentence. */
export type Answer = {
    status: number;
    code: string;
    message: string;

    /** Field-level detail, only ever from an input schema. */
    fields?: Readonly<Record<string, string>>;
};

/**
 * What a handler returns when the body alone is not the answer.
 *
 * A route returning a plain value gets 200, or 201 for a POST, which is what
 * almost every route wants. This is for the rest: a redirect, a created
 * resource naming where it went, a 304, a download with a filename.
 *
 * The body still passes the output schema. Status and headers are the only
 * things this adds, because they are the only things a schema cannot carry.
 */
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

    /** Sends the caller somewhere else. */
    static redirect(to: string, permanent = false): Reply
    {
        return new Reply(permanent ? 308 : 307, { to }, { location: to });
    }
}

/** A refusal a plugin raises on purpose, meant to reach the caller. */
export class Refusal extends Error
{
    readonly status: number;

    readonly code: string;

    readonly fields: Readonly<Record<string, string>> | undefined;

    constructor(status: number, code: string, message: string, fields?: Readonly<Record<string, string>>)
    {
        super(message);

        this.name = "Refusal";
        this.status = status;
        this.code = code;
        this.fields = fields;
    }
}

const SPOKEN: Readonly<Record<string, { status: number; message: string }>> = {
    UNAUTHENTICATED: { status: 401, message: "This request needs to be signed in." },
    PERMISSION_DENIED: { status: 403, message: "This request is not permitted." },
    RATE_LIMITED: { status: 429, message: "Too many requests. Try again shortly." },
    INVALID_PAYLOAD: { status: 400, message: "The request body is not valid." },
};

// WRONG_PAYLOAD is deliberately absent: an event or hook payload failing its
// own schema is this API's mistake, not the caller's, and telling them their
// body was wrong sends whoever debugs it looking at the wrong thing. It falls
// through to the fixed 500, and the log line names the event and the issue.

/**
 * What the caller is told about a failure.
 *
 * Nothing that was not written for a caller ever reaches one. A thrown thing
 * is either a Refusal, which a plugin wrote deliberately, or one of the few
 * kernel codes that mean something to a client. Everything else answers 500
 * with one fixed sentence, whatever it actually was.
 *
 * This is the whole point: a stack, a file path, a SQL fragment, a column
 * name, a driver message and a config value are all things an attacker learns
 * from, and none of them are things a caller needs.
 */
export function answer(cause: unknown): Answer
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
        const known = SPOKEN[cause.code];

        if (known !== undefined)
        {
            return { status: known.status, code: cause.code, message: known.message };
        }
    }

    return { status: 500, code: "INTERNAL", message: "The request could not be completed." };
}

/**
 * Whether a failure is the caller's doing or ours.
 *
 * Anything answering 500 is logged in full, because nobody saw it. A 4xx was
 * already explained to whoever caused it.
 */
export function isServerFault(given: Answer): boolean
{
    return given.status >= 500;
}
