import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { httpClient, HttpRequestError } from "../api";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { StreamedResponse } from "../../kernel/api";

let server: Server | undefined;

afterEach(async () =>
{
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

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const serve = async (handle: Handler): Promise<string> =>
{
    const listening = createServer(handle);

    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const { port } = listening.address() as { port: number };

    return `http://127.0.0.1:${String(port)}`;
};

const redirecting = (status: number, location?: string): Handler => (_request, response) =>
{
    response.writeHead(status, location === undefined ? {} : { location });
    response.end("moved");
};

describe("the outbound client meeting a redirect", () =>
{
    test("refuses it unless the call takes redirects, as it always has", async () =>
    {
        const base = await serve(redirecting(302, "/next"));

        const refusal = await httpClient()({ method: "GET", url: `${base}/` }).catch((cause: unknown) => cause);

        expect(refusal).toMatchObject({ code: "NETWORK", status: 302 });
    });

    test("hands it back read whole as REDIRECT, the location made absolute", async () =>
    {
        const base = await serve(redirecting(301, "/next?page=2"));

        const refusal = await httpClient()({ method: "GET", url: `${base}/start`, redirects: "manual" }).catch((cause: unknown) => cause);

        expect(refusal).toBeInstanceOf(HttpRequestError);
        expect(refusal).toMatchObject({ code: "REDIRECT", status: 301, location: `${base}/next?page=2` });
    });

    test("hands it back streamed with an empty body", async () =>
    {
        const base = await serve(redirecting(307, "https://elsewhere.example/"));

        const answer = await httpClient()({ method: "GET", url: `${base}/`, accepts: "stream", redirects: "manual" }) as StreamedResponse;
        const chunks: Uint8Array[] = [];

        for await (const chunk of answer.body)
        {
            chunks.push(chunk);
        }

        expect(answer).toMatchObject({ status: 307, location: "https://elsewhere.example/", url: `${base}/` });
        expect(chunks).toEqual([]);
    });

    test("refuses one with no location as malformed", async () =>
    {
        const base = await serve(redirecting(302));

        await expect(httpClient()({ method: "GET", url: `${base}/`, redirects: "manual" })).rejects.toMatchObject({ code: "MALFORMED" });
    });

    test("still refuses a 304 as STATUS, and keeps retryAfter on a streamed 503", async () =>
    {
        const base = await serve((request, response) =>
        {
            if (request.url === "/busy")
            {
                response.writeHead(503, { "retry-after": "7" });
                response.end();

                return;
            }

            response.writeHead(304, { etag: "\"v1\"" });
            response.end();
        });
        const call = httpClient();

        const unchanged = await call({ method: "GET", url: `${base}/`, accepts: "stream", redirects: "manual" }).catch((cause: unknown) => cause);
        const busy = await call({ method: "GET", url: `${base}/busy`, accepts: "stream", redirects: "manual" }).catch((cause: unknown) => cause);

        expect(unchanged).toMatchObject({ code: "STATUS", status: 304 });
        expect(busy).toMatchObject({ code: "STATUS", status: 503, retryAfter: 7 });
    });
});
