import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Reply, Server, start } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { KernelResponse, StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";
import { testDatabase } from "./testDatabase";


const CSV = "id,name\n1,Ana\n";

const route = defineRoute();

let stopped = false;

const exports = definePlugin("exports", {
    version: "1.0.0",
    describe: "Answers downloads.",
    routes: [
        route({
            method: "GET",
            path: "/export/whole",
            describe: "A whole CSV.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({ name: z.string().default("report.csv") }),
            file: { types: ["text/csv"] },
            handle: (input) =>
            {
                return Reply.file(CSV, { type: "text/csv", filename: input.name, headers: { "cache-control": "private, max-age=60", "set-cookie": "planted=1" } });
            },
        }),
        route({
            method: "GET",
            path: "/export/stream",
            describe: "A CSV sent row by row.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            file: { types: ["text/csv"] },
            handle: () =>
            {
                return Reply.file((async function* ()
                {
                    yield "id,name\n";
                    yield new TextEncoder().encode("1,Ana\n");
                    await Promise.resolve();
                    yield "2,Bo\n";
                })(), { type: "text/csv", filename: "rows.csv" });
            },
        }),
        route({
            method: "GET",
            path: "/export/endless",
            describe: "A download that never ends by itself.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            file: { types: ["text/plain"] },
            handle: () =>
            {
                return Reply.file((async function* ()
                {
                    try
                    {
                        for (;;)
                        {
                            yield "line\n";
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                    }
                    finally
                    {
                        stopped = true;
                    }
                })(), { type: "text/plain", filename: "endless.txt" });
            },
        }),
        route({
            method: "GET",
            path: "/export/broken",
            describe: "A download whose source fails after the first rows.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            file: { types: ["text/csv"] },
            handle: () =>
            {
                return Reply.file((async function* ()
                {
                    yield "id\n1\n".repeat(20_000);
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    throw new Error("the database went away");
                })(), { type: "text/csv", filename: "broken.csv" });
            },
        }),
        route({
            method: "GET",
            path: "/export/wrong-type",
            describe: "Answers a type it did not declare.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            file: { types: ["text/csv"] },
            handle: () =>
            {
                return Reply.file("{}", { type: "application/json", filename: "a.json" });
            },
        }),
        route({
            method: "GET",
            path: "/json",
            describe: "A JSON route answering a file.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () =>
            {
                return Reply.file(CSV, { type: "text/csv", filename: "a.csv" });
            },
        }),
    ],
});

let api: TestKernel | undefined;
let app: StartedApp | undefined;

afterEach(async () =>
{
    await api?.stop();
    await app?.stop();
    api = undefined;
    app = undefined;
    stopped = false;
});

const get = (path: string, input: Record<string, unknown> = {}, ifNoneMatch?: string): Promise<KernelResponse> =>
{
    return (api as TestKernel).kernel.handle({ method: "GET", path, input, ...ifNoneMatch !== undefined && { ifNoneMatch } });
};

// Waits for what a timer or another side brings about, however long a busy machine takes, rather than a fixed margin.
async function until(isMet: () => boolean, limitMs = 10_000): Promise<void>
{
    const end = Date.now() + limitMs;

    while (!isMet() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("a file route", () =>
{
    test("answers an attachment of the declared type, keeping only the headers a file may set", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/whole");

        expect(answer.body).toBe(CSV);
        expect(answer.headers).toMatchObject({
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=\"report.csv\"; filename*=UTF-8''report.csv",
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=60",
            etag: expect.stringMatching(/^W\/"/),
        });
        expect(answer.headers?.["set-cookie"]).toBeUndefined();
    });

    test("never lets a filename walk a path, break the header or carry a quote", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/whole", { name: "../../etc/pa\"ss;wd\r\nX-Evil: 1.csv" });
        const disposition = answer.headers?.["content-disposition"] ?? "";

        expect(disposition).not.toMatch(/[\r\n]/);
        expect(disposition).not.toContain("/");
        expect(disposition.split("filename=")[1]?.split(";")[0]).toBe("\".._.._etc_pa_ss_wd__X-Evil: 1.csv\"");
    });

    test("keeps a name outside ASCII in filename* and a readable fallback", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/whole", { name: "Izveštaj đak.csv" });

        expect(answer.headers?.["content-disposition"]).toBe("attachment; filename=\"Izvestaj ak.csv\"; filename*=UTF-8''Izve%C5%A1taj%20%C4%91ak.csv");
    });

    // 04's review of 3e.
    test("cuts a long name by code points, never splitting an emoji into a 500", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/whole", { name: `${"a".repeat(199)}😀.csv` });

        expect(answer.status).toBe(200);
        expect(answer.headers?.["content-disposition"]).toContain(`filename*=UTF-8''${"a".repeat(199)}%F0%9F%98%80`);
    });

    test("strips bidi and line separators and escapes what RFC 5987 does not allow", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/whole", { name: "report\u202Egpj\u2028\u0085(1)*'.csv" });
        const disposition = answer.headers?.["content-disposition"] ?? "";

        expect(disposition).not.toMatch(/%E2%80%AE|%E2%80%A8|%C2%85/);
        expect(disposition).toContain("%281%29%2A%27.csv");
    });

    test("repeats the disposition on a 304", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const first = await get("/export/whole");
        const again = await get("/export/whole", {}, first.headers?.etag);

        expect(again.status).toBe(304);
        expect(again.headers?.["content-disposition"]).toBe(first.headers?.["content-disposition"]);
    });

    test("sends chunks as they come, text and bytes alike", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/stream");
        const chunks: string[] = [];

        for await (const chunk of answer.body as AsyncIterable<Uint8Array>)
        {
            chunks.push(new TextDecoder().decode(chunk));
        }

        expect(answer.headers?.["content-disposition"]).toContain("rows.csv");
        expect(chunks.join("")).toBe("id,name\n1,Ana\n2,Bo\n");
    });

    test("answers 304 to a matching If-None-Match", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const first = await get("/export/whole");
        const again = await get("/export/whole", {}, first.headers?.etag);

        expect(again.status).toBe(304);
        expect(again.body).toBeNull();
    });

    test("refuses a type the route did not declare", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/export/wrong-type");

        expect(answer.status).toBe(500);
    });

    test("is the only kind of route that may answer one", async () =>
    {
        api = await startTestKernel({ plugins: [exports] });

        const answer = await get("/json");

        expect(answer.status).toBe(500);
        expect(api.logLines.some((line) => line.line.includes("answered a file, and declares no file"))).toBe(true);
    });
});

describe("a file route declared wrongly", () =>
{
    const declaring = (extra: Record<string, unknown>) => definePlugin("odd", {
        version: "1.0.0",
        describe: "Declares a download wrongly.",
        routes: [route({ method: "GET", path: "/odd", describe: "Wrongly declared.", public: true, limit: { requests: 1, seconds: 1 }, input: z.object({}), handle: () => "", ...extra })],
    });

    test.each([
        ["an HTML type", { file: { types: ["text/html"] } }, "declares file types \"text/html\""],
        ["an SVG type", { file: { types: ["image/svg+xml"] } }, "declares file types \"image/svg+xml\""],
        ["no type", { file: { types: [] } }, "declares file types none"],
        ["an output beside it", { file: { types: ["text/csv"] }, output: z.object({}) }, "declares output and file"],
    ])("is refused at startup with %s", async (_what, extra, reason) =>
    {
        await expect(startTestKernel({ plugins: [declaring(extra)] })).rejects.toThrow(reason);
    });
});

describe("over HTTP", () =>
{
    const serve = async (): Promise<string> =>
    {
        app = await start({ plugins: [exports], database: await testDatabase(), sockets: false });
        const server = Server.listen(app, 0, { hostname: "127.0.0.1" }) as HttpServer;

        if (!server.listening)
        {
            await new Promise((resolve) => server.once("listening", resolve));
        }

        const { port } = server.address() as { port: number };
        const stopping = app.stop;
        app = { ...app, stop: async () =>
        {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await stopping();
        } };

        return `http://127.0.0.1:${String(port)}`;
    };

    test("streams a download with its type, disposition and the kit's policy", async () =>
    {
        const base = await serve();

        const response = await fetch(`${base}/export/stream`, { headers: { connection: "close" } });

        expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
        expect(response.headers.get("content-disposition")).toContain("attachment");
        expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(await response.text()).toBe("id,name\n1,Ana\n2,Bo\n");
    });

    test("breaks the connection when the source fails midway, so a truncated file never arrives whole", async () =>
    {
        const base = await serve();

        // No "connection: close" here: with it, undici takes the closed socket for the end
        // of the body even mid-chunk, where a browser reports the chunked encoding incomplete.
        const reading = fetch(`${base}/export/broken`).then((response) => response.text());

        await expect(reading).rejects.toThrow();
    });

    test("stops the source when the caller leaves", async () =>
    {
        const base = await serve();
        const leaving = new AbortController();

        const response = await fetch(`${base}/export/endless`, { signal: leaving.signal, headers: { connection: "close" } });
        await response.body!.getReader().read();
        leaving.abort();
        await until(() => stopped);

        expect(stopped).toBe(true);
    });
});
