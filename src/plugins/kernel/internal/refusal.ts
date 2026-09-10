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

const CLIENT_FAULTS: Readonly<Record<string, { status: number; message: string }>> = {
    UNAUTHENTICATED: { status: 401, message: "This request needs to be signed in." },
    PERMISSION_DENIED: { status: 403, message: "This request is not permitted." },
    RATE_LIMITED: { status: 429, message: "Too many requests. Try again shortly." },
    INVALID_PAYLOAD: { status: 400, message: "The request body is not valid." },
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
