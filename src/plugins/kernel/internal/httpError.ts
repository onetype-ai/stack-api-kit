/** Why an outbound call failed, as a closed set a caller branches on. */
export type HttpRequestErrorCode = "TIMEOUT" | "ABORTED" | "NETWORK" | "TOO_LARGE" | "MALFORMED" | "STATUS" | "REDIRECT" | "TOO_MANY_REDIRECTS";

/** An outbound call that failed. Owned here with the `HttpClient` contract it belongs to, so the kernel can read one while following redirects. */
export class HttpRequestError extends Error
{
    readonly code: HttpRequestErrorCode;

    readonly status: number | undefined;

    /** How long the partner asked to be left alone, in seconds. */
    readonly retryAfter: number | undefined;

    /** Where a redirect pointed, absolute, on REDIRECT. */
    readonly location: string | undefined;

    constructor(code: HttpRequestErrorCode, message: string, status?: number, cause?: unknown, retryAfter?: number, location?: string)
    {
        super(message, cause === undefined ? undefined : { cause });

        this.name = "HttpRequestError";
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
        this.location = location;
    }
}
