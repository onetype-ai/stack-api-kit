import type { Subscription } from "../../http/api";
import { ServerEvent } from "../../kernel/api";

import type { Identity } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

type Incoming = {
    id?: unknown;
    method?: unknown;
    path?: unknown;
    query?: unknown;
    body?: unknown;
    headers?: unknown;
    subscribe?: unknown;
    unsubscribe?: unknown;
};

type Method = Parameters<StartedApp["kernel"]["handle"]>[0]["method"];

/** Who a socket's frames are asked as: the identity its upgrade gave, the address it came from, and what ends it. */
export type SocketCaller = {
    identity?: Identity | undefined;
    address?: string | undefined;
    signal?: AbortSignal | undefined;
};

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>>
{
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One event of a streamed answer, as a frame carries it; a raw last frame travels as its text. */
function eventOf(event: unknown): { data: unknown; event?: string; id?: string }
{
    if (event instanceof ServerEvent)
    {
        return { data: event.data, ...(event.event !== undefined && { event: event.event }), ...(event.id !== undefined && { id: event.id }) };
    }

    return isRecord(event) && typeof event["raw"] === "string" ? { data: event["raw"] } : { data: event };
}

/**
 * One frame from a client: a subscription change, or a whole request.
 *
 * A frame that is not a JSON object, or asks for nothing the kernel knows, is answered
 * rather than thrown: a socket that closes on a bad frame takes every other subscription
 * on it down too. A subscribe is answered either way, with one code for a channel that
 * does not exist and one the caller may not hear, so nobody learns which channels exist.
 * A request is asked as the socket's caller, and a streamed answer goes out as one
 * `{ id, event }` frame per event, then `{ id, status, done: true }`.
 */
export async function handleSocketMessage(
    api: StartedApp,
    subscription: Subscription | undefined,
    text: string,
    send: (text: string) => void,
    caller: SocketCaller = {},
): Promise<void>
{
    let request: Incoming;

    try
    {
        const parsed: unknown = JSON.parse(text);

        if (!isRecord(parsed))
        {
            throw new TypeError("not an object");
        }

        request = parsed;
    }
    catch
    {
        send(JSON.stringify({ status: 400, body: { code: "BAD_FRAME", message: "A frame must be a JSON object." } }));

        return;
    }

    if (typeof request.subscribe === "string")
    {
        const channel = request.subscribe;
        const heard = subscription?.listen(channel) === true;

        send(JSON.stringify(heard ? { channel, subscribed: true } : { channel, error: { code: "CHANNEL_REFUSED" } }));

        return;
    }

    if (typeof request.unsubscribe === "string")
    {
        subscription?.unlisten(request.unsubscribe);

        return;
    }

    const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";

    if (!METHODS.has(method))
    {
        send(JSON.stringify({ id: request.id, status: 400, body: { code: "BAD_FRAME", message: "A request frame names a method and a path." } }));

        return;
    }

    const headers = isRecord(request.headers)
        ? Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, value]) => [name.toLowerCase(), value]))
        : {};

    const answer = await api.kernel.handle({
        method: method as Method,
        path: typeof request.path === "string" ? request.path : "/",
        input: { ...(isRecord(request.query) ? request.query : {}), ...(isRecord(request.body) ? request.body : {}) },
        headers,
        identity: caller.identity,
        from: caller.address ?? "socket",
        ...(caller.signal !== undefined && { signal: caller.signal }),
    });

    const body: unknown = answer.body;

    if (body === null || typeof body !== "object" || !(Symbol.asyncIterator in body))
    {
        send(JSON.stringify({ id: request.id, status: answer.status, body }));

        return;
    }

    for await (const event of body as AsyncIterable<unknown>)
    {
        if (caller.signal?.aborted === true)
        {
            return;
        }

        send(JSON.stringify({ id: request.id, event: eventOf(event) }));
    }

    send(JSON.stringify({ id: request.id, status: answer.status, done: true }));
}
