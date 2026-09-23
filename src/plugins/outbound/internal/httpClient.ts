import type { HttpClient, HttpRequest } from "../../kernel/api";

import { pinnedFetch } from "./pinned";

/** How the built-in caller is configured: `timeoutMs` defaults to 10000, `maxBytes` to 5000000, and `headers` is called per request so a rotating credential stays fresh. */
export type HttpClientOptions = {
    timeoutMs?: number;

    /** The most any one call may ask for with its own `timeoutMs`: 600000 when left out. */
    mostTimeoutMs?: number;

    maxBytes?: number;

    /** The most any one call may ask for with its own `maxBytes`: `maxBytes` when left out, so no call reads more unless this is raised. */
    mostMaxBytes?: number;

    headers?: (() => Readonly<Record<string, string>>) | undefined;
};

/** Whether a size is one that bounds anything: NaN, Infinity and fractions compare in ways no read can stop on. */
function isByteCount(value: number): boolean
{
    return Number.isSafeInteger(value) && value >= 1;
}

export class HttpRequestError extends Error
{
    readonly code: "TIMEOUT" | "ABORTED" | "NETWORK" | "TOO_LARGE" | "MALFORMED" | "STATUS";

    readonly status: number | undefined;

    /** How long the partner asked to be left alone, in seconds. */
    readonly retryAfter: number | undefined;

    constructor(code: HttpRequestError["code"], message: string, status?: number, cause?: unknown, retryAfter?: number)
    {
        super(message, cause === undefined ? undefined : { cause });

        this.name = "HttpRequestError";
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

/** Whether a body is already bytes. */
function isBinaryType(body: unknown): body is Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams
{
    return body instanceof Uint8Array
        || body instanceof ArrayBuffer
        || body instanceof Blob
        || body instanceof FormData
        || body instanceof URLSearchParams;
}

/** What goes on the wire: bytes as they are, everything else as JSON. */
function toRequestBody(body: unknown): Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | string
{
    return isBinaryType(body) ? body : JSON.stringify(body);
}

/** Where a call is sent elsewhere; 300 names no one place and 304 answers a conditional request, so neither is one. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Builds the outbound caller: it follows no redirects, reads at most `maxBytes`, gives up after `timeoutMs`, dials the address it is pinned to when given one, and throws `HttpRequestError` for every failure including a non-2xx status. */
export function httpClient(options: HttpClientOptions = {}): HttpClient
{
    for (const name of ["maxBytes", "mostMaxBytes"] as const)
    {
        const given = options[name];

        if (given !== undefined && !isByteCount(given))
        {
            throw new TypeError(`httpClient: ${name} is ${String(given)}. Give a whole number of bytes above 0, or leave it out.`);
        }
    }

    const defaultMs = options.timeoutMs ?? 10_000;
    const mostTimeoutMs = options.mostTimeoutMs ?? 600_000;
    const defaultBytes = options.maxBytes ?? 5_000_000;
    const mostMaxBytes = options.mostMaxBytes ?? defaultBytes;

    return async (call, pin) =>
    {
        if (call.maxBytes !== undefined && !isByteCount(call.maxBytes))
        {
            throw new HttpRequestError("MALFORMED", `maxBytes is ${String(call.maxBytes)}. Pass a whole number of bytes above 0, or leave it out.`);
        }

        // asking for more than the process allows is clamped, not refused
        const timeoutMs = Math.min(call.timeoutMs ?? defaultMs, mostTimeoutMs);
        const maxBytes = Math.min(call.maxBytes ?? defaultBytes, mostMaxBytes);

        const stopper = new AbortController();
        const timer = setTimeout(() => stopper.abort(), timeoutMs);
        const cancel = (): void =>
        {
            stopper.abort();
        };

        call.signal?.addEventListener("abort", cancel);

        const release = (): void =>
        {
            clearTimeout(timer);
            call.signal?.removeEventListener("abort", cancel);
        };

        // a streamed answer keeps its limits until its last chunk, so they are released there
        let streaming = false;

        try
        {
            const response = await (pin === undefined ? fetch : pinnedFetch(pin))(call.url, {
                method: call.method,
                signal: stopper.signal,

                // never followed here: the kernel checked the first url and never sees the second
                redirect: "manual",

                headers: {
                    accept: call.accepts === "json" || call.accepts === undefined ? "application/json" : "*/*",
                    ...(call.body !== undefined && !isBinaryType(call.body) && { "content-type": "application/json" }),
                    ...options.headers?.(),
                    ...call.headers,
                },
                ...(call.body !== undefined && { body: toRequestBody(call.body) }),
            });

            if (REDIRECT_STATUSES.has(response.status))
            {
                await response.body?.cancel().catch(() => undefined);

                throw new HttpRequestError("NETWORK", `The call was redirected (${response.status}), and redirects are not followed.`, response.status);
            }

            if (call.accepts === "stream" && response.ok)
            {
                streaming = true;

                return {
                    status: response.status,
                    headers: Object.fromEntries(response.headers),
                    url: call.url,
                    body: streamOf(response, { maxBytes, idleMs: call.idleMs, stopper, call, timeoutMs, release }),
                };
            }

            const text = await readResponseBody(response, maxBytes);

            if (!response.ok)
            {
                throw new HttpRequestError(
                    "STATUS",
                    `The call was refused with status ${response.status}.`,
                    response.status,
                    undefined,
                    retryDelay(response.headers.get("retry-after")),
                );
            }

            if (call.accepts === "text")
            {
                return text;
            }

            if (text === "")
            {
                return undefined;
            }

            try
            {
                return JSON.parse(text);
            }
            catch (cause)
            {
                throw new HttpRequestError("MALFORMED", "The answer was not valid JSON.", response.status, cause);
            }
        }
        catch (cause)
        {
            throw toOutboundFault(cause, call, stopper, timeoutMs);
        }
        finally
        {
            if (!streaming)
            {
                release();
            }
        }
    };
}

/** What bounds a streamed answer until its last chunk. */
type StreamLimits = {
    maxBytes: number;
    idleMs: number | undefined;
    stopper: AbortController;
    call: HttpRequest;
    timeoutMs: number;
    release: () => void;
};

/**
 * The body as it arrives. The call's time limit, its byte limit and the caller's signal
 * hold until the last chunk; a silence longer than `idleMs` ends it too. Leaving the loop
 * early cancels the body, so nothing keeps the socket open.
 */
async function* streamOf(response: Response, limits: StreamLimits): AsyncGenerator<Uint8Array>
{
    const reader = response.body?.getReader();

    let size = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let wentIdle = false;

    const waiting = (): void =>
    {
        if (limits.idleMs !== undefined)
        {
            clearTimeout(idle);

            idle = setTimeout(() =>
            {
                wentIdle = true;
                limits.stopper.abort();
            }, limits.idleMs);
        }
    };

    try
    {
        if (reader === undefined)
        {
            return;
        }

        waiting();

        for (;;)
        {
            const { done, value } = await reader.read();

            if (done)
            {
                return;
            }

            size += value.length;

            if (size > limits.maxBytes)
            {
                throw new HttpRequestError("TOO_LARGE", `The answer went past ${limits.maxBytes} bytes.`);
            }

            waiting();

            yield value;
        }
    }
    catch (cause)
    {
        if (wentIdle && !(cause instanceof HttpRequestError))
        {
            throw new HttpRequestError("TIMEOUT", `The answer went silent for more than ${String(limits.idleMs)}ms.`, undefined, cause);
        }

        throw toOutboundFault(cause, limits.call, limits.stopper, limits.timeoutMs);
    }
    finally
    {
        clearTimeout(idle);
        limits.release();
        await reader?.cancel().catch(() => undefined);
    }
}

/** What a Retry-After asks for, in seconds. */
function retryDelay(header: string | null): number | undefined
{
    if (header === null)
    {
        return undefined;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds) && seconds >= 0)
    {
        return Math.round(seconds);
    }

    const moment = Date.parse(header);

    return Number.isNaN(moment) ? undefined : Math.max(0, Math.round((moment - Date.now()) / 1000));
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string>
{
    const reader = response.body?.getReader();

    if (reader === undefined)
    {
        return "";
    }

    const chunks: Uint8Array[] = [];

    let size = 0;

    for (;;)
    {
        const { done, value } = await reader.read();

        if (done)
        {
            break;
        }

        size += value.length;

        if (size > maxBytes)
        {
            await reader.cancel();

            throw new HttpRequestError("TOO_LARGE", `The answer went past ${maxBytes} bytes.`);
        }

        chunks.push(value);
    }

    return new TextDecoder().decode(joinChunks(chunks, size));
}

function joinChunks(chunks: readonly Uint8Array[], size: number): Uint8Array
{
    const whole = new Uint8Array(size);

    let written = 0;

    for (const chunk of chunks)
    {
        whole.set(chunk, written);
        written += chunk.length;
    }

    return whole;
}

function toOutboundFault(cause: unknown, call: HttpRequest, stopper: AbortController, timeoutMs: number): unknown
{
    if (cause instanceof HttpRequestError)
    {
        return cause;
    }

    if (call.signal?.aborted === true)
    {
        return new HttpRequestError("ABORTED", "The call was cancelled by the caller.", undefined, cause);
    }

    if (stopper.signal.aborted)
    {
        return new HttpRequestError("TIMEOUT", `The call did not answer within ${timeoutMs}ms.`, undefined, cause);
    }

    return new HttpRequestError("NETWORK", "The call could not reach the host.", undefined, cause);
}
