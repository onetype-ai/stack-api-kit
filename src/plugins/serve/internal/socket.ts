import type { Subscription } from "../../http/api";
import type { StartedApp } from "../../mount/api";

type Incoming = {
    id?: string;
    method?: string;
    path?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    subscribe?: string;
    unsubscribe?: string;
};

type Method = Parameters<StartedApp["kernel"]["handle"]>[0]["method"];

/**
 * One frame from a client: a subscription change, or a whole request.
 *
 * A frame that is not JSON, or asks for nothing the kernel knows, is answered
 * rather than thrown: a socket that closes on a bad frame takes every other
 * subscription on it down too.
 */
export async function handleSocketMessage(
    api: StartedApp,
    subscription: Subscription | undefined,
    text: string,
    send: (text: string) => void,
): Promise<void>
{
    let request: Incoming;

    try
    {
        request = JSON.parse(text) as Incoming;
    }
    catch
    {
        send(JSON.stringify({ status: 400, body: { code: "BAD_FRAME", message: "A frame must be JSON." } }));

        return;
    }

    if (request.subscribe !== undefined)
    {
        subscription?.listen(request.subscribe);

        return;
    }

    if (request.unsubscribe !== undefined)
    {
        subscription?.unlisten(request.unsubscribe);

        return;
    }

    const answer = await api.kernel.handle({
        method: (request.method ?? "GET") as Method,
        path: request.path ?? "/",
        input: { ...request.query, ...request.body },
        headers: request.headers ?? {},
        from: "socket",
    });

    send(JSON.stringify({ id: request.id, status: answer.status, body: answer.body }));
}
