import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Server, ServerEvent, start } from "../../index";
import { createIdentity, startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { KernelResponse, StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";
import { testDatabase } from "./testDatabase";


type Seen = { event: string | undefined; id: string | undefined; data: unknown };

const route = defineRoute();
const Token = z.object({ token: z.string() });

let aborted = false;
let started = 0;

const chat = definePlugin("chat", {
    version: "1.0.0",
    describe: "Streams an answer token by token.",
    permissions: { "chat.read": { describe: "Read answers." } },
    routes: [
        route({
            method: "POST",
            path: "/chat/stream",
            describe: "Streams tokens, one of them carrying a field its schema does not name.",
            requires: ["chat.read"],
            limit: { requests: 2, seconds: 60 },
            input: z.object({ prompt: z.string() }),
            streams: Token,
            handle: function* ()
            {
                yield { token: "Hello" };
                yield { token: " world", internalCost: 0.002 };
                yield new ServerEvent({ token: "" }, { event: "done", id: "3" });
            },
        }),
        route({
            method: "GET",
            path: "/chat/broken",
            describe: "Fails after the first token.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            streams: Token,
            handle: function* ()
            {
                yield { token: "partial" };
                throw new Error("connect to db with password=PLANTED failed");
            },
        }),
        route({
            method: "GET",
            path: "/chat/shapeless",
            describe: "Yields what its schema refuses.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            streams: Token,
            handle: function* ()
            {
                yield { token: 42 };
            },
        }),
        route({
            method: "GET",
            path: "/chat/forever",
            describe: "Streams until the caller goes.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            streams: Token,
            handle: async function* (_input, ctx)
            {
                started += 1;

                while (ctx.signal?.aborted !== true)
                {
                    yield { token: "." };
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }

                aborted = true;
            },
        }),
        route({
            method: "GET",
            path: "/chat/brief",
            describe: "Streams for a tenth of a second at most.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            streams: Token,
            streamSeconds: 0.1,
            handle: async function* (_input, ctx)
            {
                while (ctx.signal?.aborted !== true)
                {
                    yield { token: "." };
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }

                aborted = true;
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
    aborted = false;
    started = 0;
});

const drain = async (response: KernelResponse): Promise<Seen[]> =>
{
    const seen: Seen[] = [];

    for await (const event of response.body as AsyncIterable<ServerEvent>)
    {
        seen.push({ event: event.event, id: event.id, data: event.data });
    }

    return seen;
};

const reader = createIdentity(["chat.read"], "ana");

// Waits for what a timer or another side brings about, however long a busy machine takes, rather than a fixed margin.
async function until(isMet: () => boolean, limitMs = 10_000): Promise<void>
{
    const end = Date.now() + limitMs;

    while (!isMet() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("a streamed route", () =>
{
    test("sends each event filtered by its streams schema, with its SSE fields", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const response = await api.kernel.handle({ method: "POST", path: "/chat/stream", input: { prompt: "hi" }, identity: reader });

        expect(response.status).toBe(200);
        expect(response.headers).toMatchObject({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
        expect(await drain(response)).toEqual([
            { event: undefined, id: undefined, data: { token: "Hello" } },
            { event: undefined, id: undefined, data: { token: " world" } },
            { event: "done", id: "3", data: { token: "" } },
        ]);
    });

    test("refuses a caller without the permission before anything streams", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const response = await api.kernel.handle({ method: "POST", path: "/chat/stream", input: { prompt: "hi" }, identity: createIdentity([], "bo") });

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: "PERMISSION_DENIED" });
    });

    test("refuses nobody signed in, and bad input, as any route does", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const anonymous = await api.kernel.handle({ method: "POST", path: "/chat/stream", input: { prompt: "hi" } });
        const invalid = await api.kernel.handle({ method: "POST", path: "/chat/stream", input: { prompt: 7 }, identity: reader });

        expect(anonymous.status).toBe(401);
        expect(invalid.status).toBe(400);
    });

    test("counts one request against its limit, however many events it sends", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });
        const ask = () => (api as TestKernel).kernel.handle({ method: "POST", path: "/chat/stream", input: { prompt: "hi" }, identity: reader });

        await drain(await ask());
        await drain(await ask());
        const third = await ask();

        expect(third.status).toBe(429);
    });

    test("ends with a neutral error event when it fails after the first event, the cause going to the log", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const seen = await drain(await api.kernel.handle({ method: "GET", path: "/chat/broken", input: {} }));

        expect(seen).toEqual([
            { event: undefined, id: undefined, data: { token: "partial" } },
            { event: "error", id: undefined, data: { code: "INTERNAL", message: "The request could not be completed." } },
        ]);
        expect(JSON.stringify(seen)).not.toContain("PLANTED");
        expect(api.logLines.some((line) => line.line.includes("threw while streaming"))).toBe(true);
    });

    test("ends with an error event, never the value, when an event breaks its schema", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const seen = await drain(await api.kernel.handle({ method: "GET", path: "/chat/shapeless", input: {} }));

        expect(seen).toEqual([{ event: "error", id: undefined, data: { code: "INTERNAL", message: "The request could not be completed." } }]);
    });
});

// c7's conditions on SSE (patch 3c).
describe("an open stream's limits", () =>
{
    const first = async (response: KernelResponse): Promise<AsyncIterator<ServerEvent>> =>
    {
        const events = (response.body as AsyncIterable<ServerEvent>)[Symbol.asyncIterator]();
        await events.next();

        return events;
    };

    const rest = async (events: AsyncIterator<ServerEvent>): Promise<Seen[]> =>
    {
        const seen: Seen[] = [];

        for (let next = await events.next(); next.done !== true; next = await events.next())
        {
            seen.push({ event: next.value.event, id: next.value.id, data: next.value.data });
        }

        return seen;
    };

    test("one caller holds at most four at once, refused before the fifth handler runs", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });
        const open = async (): Promise<KernelResponse> => (api as TestKernel).kernel.handle({ method: "GET", path: "/chat/forever", input: {} });
        const held = await Promise.all([open(), open(), open(), open()]);
        const heldEvents = await Promise.all(held.map(first));

        const fifth = await open();
        const handlersRun = started;
        await heldEvents[0]?.return?.();
        const afterOneClosed = await open();
        await Promise.all([...heldEvents.slice(1), (afterOneClosed.body as AsyncIterable<ServerEvent>)[Symbol.asyncIterator]()].map(async (events) =>
        {
            await events.return?.();
        }));

        expect(fifth.status).toBe(429);
        expect(fifth.body).toMatchObject({ code: "TOO_MANY_STREAMS" });
        expect(handlersRun).toBe(4);
        expect(afterOneClosed.status).toBe(200);
    });

    test("ends with EXPIRED once it outlives its route's streamSeconds, aborting the handler", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });

        const seen = await drain(await api.kernel.handle({ method: "GET", path: "/chat/brief", input: {} }));
        await until(() => aborted);

        expect(seen.at(-1)).toEqual({ event: "error", id: undefined, data: { code: "EXPIRED", message: "The stream reached its time limit. Reconnect to continue." } });
        expect(aborted).toBe(true);
    });

    test("is forgotten once it ends, so stopping waits for nothing", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });
        await drain(await api.kernel.handle({ method: "GET", path: "/chat/broken", input: {} }));

        const before = performance.now();
        await api.stop();
        api = undefined;

        expect(performance.now() - before).toBeLessThan(1000);
    });

    test("ends with RESTARTING when the kernel stops, never a silent cut", async () =>
    {
        api = await startTestKernel({ plugins: [chat] });
        const events = await first(await api.kernel.handle({ method: "GET", path: "/chat/forever", input: {} }));

        const [seen] = await Promise.all([rest(events), api.stop()]);
        api = undefined;

        expect(seen.at(-1)).toEqual({ event: "error", id: undefined, data: { code: "RESTARTING", message: "The service is restarting. Reconnect shortly." } });
    });
});

describe("a route declaring how it streams", () =>
{
    const declaring = (extra: Record<string, unknown>) => definePlugin("odd", {
        version: "1.0.0",
        describe: "Declares a streamed route wrongly.",
        routes: [route({
            method: "GET",
            path: "/odd",
            describe: "Wrongly declared.",
            public: true,
            limit: { requests: 1, seconds: 1 },
            input: z.object({}),
            handle: function* ()
            {
                yield {};
            },
            ...extra,
        })],
    });

    test.each([0, -1, 86401])("is refused at startup with streamSeconds %s", async (seconds) =>
    {
        const booting = startTestKernel({ plugins: [declaring({ streams: Token, streamSeconds: seconds })] });

        await expect(booting).rejects.toThrow(`gives streamSeconds ${String(seconds)}`);
    });

    test("is refused at startup when its streams schema cannot strip what it does not name", async () =>
    {
        const booting = startTestKernel({ plugins: [declaring({ streams: z.record(z.string(), z.string()) })] });

        await expect(booting).rejects.toThrow("streams schema that cannot filter");
    });
});

describe("over HTTP", () =>
{
    const serve = async (): Promise<string> =>
    {
        app = await start({ plugins: [chat], database: await testDatabase(), sockets: false });
        const server = Server.listen(app, 0) as HttpServer;

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

    test("writes Server-Sent Events frames an EventSource reads", async () =>
    {
        const base = await serve();

        const response = await fetch(`${base}/chat/broken`, { headers: { connection: "close" } });
        const text = await response.text();

        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        expect(text).toBe("data: {\"token\":\"partial\"}\n\nevent: error\ndata: {\"code\":\"INTERNAL\",\"message\":\"The request could not be completed.\"}\n\n");
    });

    test("aborts ctx.signal when the caller goes away", async () =>
    {
        const base = await serve();
        const leaving = new AbortController();

        const response = await fetch(`${base}/chat/forever`, { signal: leaving.signal, headers: { connection: "close" } });
        const body = response.body!.getReader();
        await body.read();
        leaving.abort();
        await until(() => aborted);

        expect(aborted).toBe(true);
    });
});
