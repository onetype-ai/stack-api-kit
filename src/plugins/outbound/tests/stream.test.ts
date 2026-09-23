import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { httpClient } from "../api";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { StreamedResponse } from "../../kernel/api";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server | undefined;

afterEach(async () =>
{
    server?.closeAllConnections();
    const closing = server;
    server = undefined;

    if (closing !== undefined)
    {
        await new Promise((resolve) =>
        {
            closing.close(resolve);
        });
    }
});

const serve = async (handle: Handler): Promise<string> =>
{
    const listening = createServer(handle);

    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const { port } = listening.address() as { port: number };

    return `http://127.0.0.1:${String(port)}/`;
};

// Answers /<n> with n bytes, sent in 10-byte chunks so a streamed read counts as it goes.
const serveBytes = (): Promise<string> =>
{
    return serve((request, response) =>
    {
        let left = Number((request.url ?? "/0").slice(1));

        response.writeHead(200, { "content-type": "text/plain" });

        while (left > 0)
        {
            response.write("x".repeat(Math.min(10, left)));
            left -= 10;
        }

        response.end();
    }).then((url) => url.slice(0, -1));
};

const wait = (ms: number): Promise<void> =>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const text = new TextDecoder();

const streamed = (answer: unknown): StreamedResponse =>
{
    return answer as StreamedResponse;
};

const sizeOf = async (answer: StreamedResponse): Promise<number> =>
{
    let size = 0;

    for await (const chunk of answer.body)
    {
        size += chunk.byteLength;
    }

    return size;
};

describe("a streamed answer", () =>
{
    test("hands over a chunk before the answer has ended", async () =>
    {
        let finish: () => void = () => undefined;
        const url = await serve((_request, response) =>
        {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("first");
            finish = () => response.end("second");
        });
        const call = httpClient();

        const answer = streamed(await call({ method: "GET", url, accepts: "stream" }));
        const chunks: string[] = [];

        for await (const chunk of answer.body)
        {
            chunks.push(text.decode(chunk));
            finish();
        }

        expect(answer.status).toBe(200);
        expect(answer.headers["content-type"]).toBe("text/event-stream");
        expect(chunks).toEqual(["first", "second"]);
    });

    test("throws for a status outside 2xx before any of the body is handed over", async () =>
    {
        const url = await serve((_request, response) =>
        {
            response.writeHead(429, { "retry-after": "7" });
            response.end("slow down");
        });
        const call = httpClient();

        const answer = call({ method: "GET", url, accepts: "stream" });

        await expect(answer).rejects.toMatchObject({ code: "STATUS", status: 429, retryAfter: 7 });
    });

    test("stops at maxBytes counted across every chunk", async () =>
    {
        const url = await serve((_request, response) =>
        {
            response.writeHead(200);
            response.write("12345678");
            setTimeout(() => response.end("12345678"), 20);
        });
        const call = httpClient({ maxBytes: 10 });

        const answer = streamed(await call({ method: "GET", url, accepts: "stream" }));
        const reading = (async () =>
        {
            for await (const chunk of answer.body)
            {
                void chunk;
            }
        })();

        await expect(reading).rejects.toMatchObject({ code: "TOO_LARGE" });
    });

    test("ends when the answer goes silent for longer than idleMs", async () =>
    {
        const url = await serve((_request, response) =>
        {
            response.writeHead(200);
            response.write("first");
        });
        const call = httpClient({ timeoutMs: 5000 });

        const answer = streamed(await call({ method: "GET", url, accepts: "stream", idleMs: 100 }));
        const reading = (async () =>
        {
            for await (const chunk of answer.body)
            {
                void chunk;
            }
        })();

        await expect(reading).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("silent") });
    });

    test("ends when the whole call outlives its timeoutMs, even while chunks keep coming", async () =>
    {
        const url = await serve((_request, response) =>
        {
            response.writeHead(200);
            const beat = setInterval(() => response.write("."), 20);
            response.on("close", () =>
            {
                clearInterval(beat);
            });
        });
        const call = httpClient();

        const answer = streamed(await call({ method: "GET", url, accepts: "stream", timeoutMs: 200 }));
        const reading = (async () =>
        {
            for await (const chunk of answer.body)
            {
                void chunk;
            }
        })();

        await expect(reading).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    test("leaving the loop early closes the connection", async () =>
    {
        let closed = false;
        const url = await serve((_request, response) =>
        {
            response.writeHead(200);
            const beat = setInterval(() => response.write("."), 10);
            response.on("close", () =>
            {
                closed = true;
                clearInterval(beat);
            });
        });
        const call = httpClient();

        const answer = streamed(await call({ method: "GET", url, accepts: "stream" }));

        for await (const chunk of answer.body)
        {
            void chunk;
            break;
        }
        await wait(100);

        expect(closed).toBe(true);
    });
});

describe("a call's own time limit", () =>
{
    const slow = (ms: number): Handler => (_request, response) =>
    {
        setTimeout(() =>
        {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{\"done\":true}");
        }, ms);
    };

    test("may be longer than the process default", async () =>
    {
        const url = await serve(slow(150));
        const call = httpClient({ timeoutMs: 50 });

        const answer = await call({ method: "GET", url, timeoutMs: 1000 });

        expect(answer).toEqual({ done: true });
    });

    test("may be shorter than the process default", async () =>
    {
        const url = await serve(slow(300));
        const call = httpClient({ timeoutMs: 5000 });

        await expect(call({ method: "GET", url, timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    test("is never more than mostTimeoutMs", async () =>
    {
        const url = await serve(slow(300));
        const call = httpClient({ mostTimeoutMs: 100 });

        await expect(call({ method: "GET", url, timeoutMs: 60_000 })).rejects.toMatchObject({ code: "TIMEOUT" });
    });
});

describe("a call naming its own maxBytes", () =>
{
    test("reads past the default when the process allows it", async () =>
    {
        const base = await serveBytes();

        const text = await httpClient({ maxBytes: 10, mostMaxBytes: 100 })({ method: "GET", url: `${base}/50`, accepts: "text", maxBytes: 60 });

        expect(text).toHaveLength(50);
    });

    test("is held to the process ceiling, however much it asks for", async () =>
    {
        const base = await serveBytes();

        const read = httpClient({ maxBytes: 10, mostMaxBytes: 100 })({ method: "GET", url: `${base}/200`, accepts: "text", maxBytes: 1_000 });

        await expect(read).rejects.toMatchObject({ code: "TOO_LARGE" });
    });

    test("reads no more than the default where the process named no ceiling", async () =>
    {
        const base = await serveBytes();

        const read = httpClient({ maxBytes: 10 })({ method: "GET", url: `${base}/50`, accepts: "text", maxBytes: 60 });

        await expect(read).rejects.toMatchObject({ code: "TOO_LARGE" });
    });

    test("may ask for less than the default", async () =>
    {
        const base = await serveBytes();

        const read = httpClient()({ method: "GET", url: `${base}/50`, accepts: "text", maxBytes: 20 });

        await expect(read).rejects.toMatchObject({ code: "TOO_LARGE" });
    });

    test("bounds a streamed answer too, counted as it arrives", async () =>
    {
        const base = await serveBytes();
        const call = httpClient({ maxBytes: 10, mostMaxBytes: 100 });

        const within = await sizeOf(streamed(await call({ method: "GET", url: `${base}/60`, accepts: "stream", maxBytes: 80 })));
        const past = sizeOf(streamed(await call({ method: "GET", url: `${base}/90`, accepts: "stream", maxBytes: 80 })));

        expect(within).toBe(60);
        await expect(past).rejects.toMatchObject({ code: "TOO_LARGE" });
    });
});

describe("a maxBytes that bounds nothing", () =>
{
    test.each([["not a number", Number.NaN], ["zero", 0], ["negative", -5], ["a fraction", 1.5], ["infinite", Number.POSITIVE_INFINITY]])("is refused as the process's %s, naming the option", (_what, given) =>
    {
        expect(() => httpClient({ maxBytes: given })).toThrow("httpClient: maxBytes");
        expect(() => httpClient({ mostMaxBytes: given })).toThrow("httpClient: mostMaxBytes");
    });

    test.each([["not a number", Number.NaN], ["zero", 0], ["negative", -5]])("is refused as a call's %s, before anything is dialled", async (_what, given) =>
    {
        const base = await serveBytes();

        await expect(httpClient({ mostMaxBytes: 100 })({ method: "GET", url: `${base}/10`, accepts: "text", maxBytes: given })).rejects.toMatchObject({ code: "MALFORMED" });
    });
});
