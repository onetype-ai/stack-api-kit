import type { Outbound } from "../../kernel/api";

export type DialerOptions = {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: (() => Readonly<Record<string, string>>) | undefined;
};

export class OutboundFault extends Error
{
    readonly code: "TIMEOUT" | "ABORTED" | "NETWORK" | "TOO_LARGE" | "MALFORMED" | "STATUS";

    readonly status: number | undefined;

    constructor(code: OutboundFault["code"], message: string, status?: number, cause?: unknown)
    {
        super(message, cause === undefined ? undefined : { cause });

        this.name = "OutboundFault";
        this.code = code;
        this.status = status;
    }
}

/**
 * Whether a body is already bytes.
 *
 * JSON.stringify turns a Uint8Array into {"0":1,"1":2}, which is neither what
 * the caller wrote nor anything a binary protocol accepts, and it does it
 * silently. A protobuf frame reaches the wire as a frame.
 */
function binary(body: unknown): body is Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams
{
    return body instanceof Uint8Array
        || body instanceof ArrayBuffer
        || body instanceof Blob
        || body instanceof FormData
        || body instanceof URLSearchParams;
}

/** What goes on the wire: bytes as they are, everything else as JSON. */
function asBody(body: unknown): Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | string
{
    return binary(body) ? body : JSON.stringify(body);
}

// The kernel checks the host against what the plugin declared; this only
// carries the call out, and bounds what comes back.
export function dial(dialing: DialerOptions = {})
{
    const timeoutMs = dialing.timeoutMs ?? 10_000;
    const maxBytes = dialing.maxBytes ?? 5_000_000;

    return async (call: Outbound): Promise<unknown> =>
    {
        const stopper = new AbortController();
        const timer = setTimeout(() => stopper.abort(), timeoutMs);
        const cancel = (): void =>
        {
            stopper.abort();
        };

        call.signal?.addEventListener("abort", cancel);

        try
        {
            const response = await fetch(call.url, {
                method: call.method,
                signal: stopper.signal,

                // A redirect is how a permitted host hands a request to one
                // that was never declared, so the whitelist has to hold here
                // too: the kernel only saw the first url.
                redirect: "error",

                headers: {
                    accept: "application/json",
                    ...(call.body !== undefined && !binary(call.body) && { "content-type": "application/json" }),
                    ...dialing.headers?.(),
                    ...call.headers,
                },
                ...(call.body !== undefined && { body: asBody(call.body) }),
            });

            const text = await read(response, maxBytes);

            if (!response.ok)
            {
                throw new OutboundFault("STATUS", `The call was refused with status ${response.status}.`, response.status);
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
                throw new OutboundFault("MALFORMED", "The answer was not valid JSON.", response.status, cause);
            }
        }
        catch (cause)
        {
            throw toFault(cause, call, stopper, timeoutMs);
        }
        finally
        {
            clearTimeout(timer);
            call.signal?.removeEventListener("abort", cancel);
        }
    };
}

// Read in chunks rather than at once: content-length is what the other side
// claimed, and a body that keeps arriving is how one call takes the process
// down.
async function read(response: Response, maxBytes: number): Promise<string>
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

            throw new OutboundFault("TOO_LARGE", `The answer went past ${maxBytes} bytes.`);
        }

        chunks.push(value);
    }

    return new TextDecoder().decode(join(chunks, size));
}

function join(chunks: readonly Uint8Array[], size: number): Uint8Array
{
    const whole = new Uint8Array(size);

    let at = 0;

    for (const chunk of chunks)
    {
        whole.set(chunk, at);
        at += chunk.length;
    }

    return whole;
}

// The caller's own abort and our timeout both surface as one AbortError, and
// they are not the same event.
function toFault(cause: unknown, call: Outbound, stopper: AbortController, timeoutMs: number): unknown
{
    if (cause instanceof OutboundFault)
    {
        return cause;
    }

    if (call.signal?.aborted === true)
    {
        return new OutboundFault("ABORTED", "The call was cancelled by the caller.", undefined, cause);
    }

    if (stopper.signal.aborted)
    {
        return new OutboundFault("TIMEOUT", `The call did not answer within ${timeoutMs}ms.`, undefined, cause);
    }

    return new OutboundFault("NETWORK", "The call could not reach the host.", undefined, cause);
}
