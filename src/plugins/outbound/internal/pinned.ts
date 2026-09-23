import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import type { ResolvedAddress } from "../../kernel/api";

/** Statuses that answer with no body at all. */
const EMPTY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The same call as `fetch`, dialled at the address the kernel checked rather than at
 * whatever the name resolves to now. TLS still verifies the name.
 */
export function pinnedFetch(pin: ResolvedAddress): typeof fetch
{
    return async (url, init) =>
    {
        const request = new Request(url, init);
        const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());

        return new Promise<Response>((resolve, reject) =>
        {
            const outgoing = httpsRequest(request.url, {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                ...(init?.signal !== undefined && init.signal !== null && { signal: init.signal }),

                lookup: (_hostname, options, answer) =>
                {
                    if (options.all === true)
                    {
                        answer(null, [{ address: pin.address, family: pin.family }]);
                    }
                    else
                    {
                        answer(null, pin.address, pin.family);
                    }
                },
            }, (incoming) =>
            {
                const status = incoming.statusCode ?? 502;
                const headers = new Headers();

                for (const [name, value] of Object.entries(incoming.headers))
                {
                    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value])
                    {
                        headers.append(name, one);
                    }
                }

                const empty = EMPTY_STATUSES.has(status);

                if (empty)
                {
                    incoming.resume();
                }

                resolve(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
            });

            outgoing.on("error", (cause) =>
            {
                reject(init?.signal?.aborted === true ? init.signal.reason : new TypeError("fetch failed", { cause }));
            });

            outgoing.end(body);
        });
    };
}
