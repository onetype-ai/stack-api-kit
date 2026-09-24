import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Reply, Server, start } from "../../index";
import { createIdentity, startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";
import { testDatabase } from "./testDatabase";


const route = defineRoute();
const Answer = z.object({ text: z.string() });
const Part = z.object({ type: z.string(), delta: z.string().optional() });
const Asking = z.object({
    stream: z.boolean(),
    fails: z.boolean().optional(),
    header: z.string().optional(),
    end: z.string().optional(),
    waitMs: z.number().optional(),
    cache: z.string().optional(),
    unshapedError: z.boolean().optional(),
});

const STREAM_HEADER = "x-vercel-ai-ui-message-stream";

const parts = async function* (fails: boolean): AsyncGenerator
{
    yield { type: "text-delta", delta: "Hi", internalCost: 0.002 };
    await Promise.resolve();

    if (fails)
    {
        throw new Error("The model went away with a secret in its message.");
    }

    yield { type: "finish" };
};

const assistant = definePlugin("assistant", {
    version: "1.0.0",
    describe: "Answers a message whole, or part by part when asked to stream.",
    routes: [
        route({
            method: "POST",
            path: "/messages",
            describe: "Answers whole, or streams when the caller asks.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: Asking,
            output: Answer,
            streams: Part,
            sends: [STREAM_HEADER, "cache-control"],
            handle: async (input) =>
            {
                await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? 0));

                if (!input.stream)
                {
                    return { text: "Hi", internalCost: 0.002 };
                }

                return Reply.events(parts(input.fails === true), {
                    headers: { [input.header ?? STREAM_HEADER]: "v1", ...(input.cache !== undefined && { "cache-control": input.cache }) },
                    end: input.end ?? "[DONE]",
                    error: (message) => (input.unshapedError === true ? undefined : { type: "error", errorText: message }),
                });
            },
        }),
        route({
            method: "POST",
            path: "/messages/private",
            describe: "The same, for a signed-in caller only.",
            requires: [],
            limit: { requests: 100, seconds: 60 },
            input: Asking,
            output: Answer,
            streams: Part,
            sends: [STREAM_HEADER, "cache-control"],
            handle: async (input) =>
            {
                await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? 0));

                if (!input.stream)
                {
                    return { text: "Hi", internalCost: 0.002 };
                }

                return Reply.events(parts(input.fails === true), {
                    headers: { [input.header ?? STREAM_HEADER]: "v1", ...(input.cache !== undefined && { "cache-control": input.cache }) },
                    end: input.end ?? "[DONE]",
                    error: (message) => (input.unshapedError === true ? undefined : { type: "error", errorText: message }),
                });
            },
        }),
    ],
});

let app: StartedApp | undefined;
let api: TestKernel | undefined;

afterEach(async () =>
{
    await app?.stop();
    await api?.stop();
    app = undefined;
    api = undefined;
});

const serve = async (): Promise<string> =>
{
    app = await start({ plugins: [assistant], database: await testDatabase(), sockets: false });
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

const ask = (base: string, body: z.infer<typeof Asking>): Promise<Response> =>
{
    return fetch(`${base}/messages`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
};

const viewer = createIdentity([], "viewer-1");

const handle = (kernel: TestKernel, input: z.infer<typeof Asking>): ReturnType<TestKernel["kernel"]["handle"]> =>
{
    return kernel.kernel.handle({ method: "POST", path: "/messages/private", input, identity: viewer });
};

describe("a route declaring output and streams", () =>
{
    test("answers JSON, filtered by output, when the caller does not ask to stream", async () =>
    {
        const base = await serve();

        const response = await ask(base, { stream: false });

        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ text: "Hi" });
        expect(response.headers.get(STREAM_HEADER)).toBeNull();
    });

    test("streams data-only frames with its own header and a raw last frame when asked", async () =>
    {
        const base = await serve();

        const response = await ask(base, { stream: true });
        const text = await response.text();

        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        expect(response.headers.get(STREAM_HEADER)).toBe("v1");
        expect(text).toBe("data: {\"type\":\"text-delta\",\"delta\":\"Hi\"}\n\ndata: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n");
    });

    test("ends a failing stream with the frame the handler shaped, neutral, and no last frame after it", async () =>
    {
        const base = await serve();

        const text = await (await ask(base, { stream: true, fails: true })).text();

        expect(text).toBe("data: {\"type\":\"text-delta\",\"delta\":\"Hi\"}\n\ndata: {\"type\":\"error\",\"errorText\":\"The request could not be completed.\"}\n\n");
    });

    test("frees the caller's stream slot when it answers JSON, so answers never count as open streams", async () =>
    {
        const base = await serve();
        const statuses: number[] = [];

        for (let call = 0; call < 6; call += 1)
        {
            const response = await ask(base, { stream: false });
            statuses.push(response.status);
            await response.body?.cancel();
        }

        expect(statuses).toEqual([201, 201, 201, 201, 201, 201]);
    });
});

describe("the stream cap on a route answering either way", () =>
{
    test("never counts a JSON answer, even with every stream slot taken", async () =>
    {
        api = await startTestKernel({ plugins: [assistant] });
        const open = await Promise.all([1, 2, 3, 4].map(() => handle(api!, { stream: true })));

        const answer = await handle(api, { stream: false });

        expect(open.map((each) => each.status)).toEqual([200, 200, 200, 200]);
        expect(answer.status).toBe(201);
    });

    test("lets a stream open while slow JSON answers are still being worked out", async () =>
    {
        api = await startTestKernel({ plugins: [assistant] });
        const slow = [1, 2, 3, 4].map(() => handle(api!, { stream: false, waitMs: 200 }));

        const streaming = await handle(api, { stream: true });
        await Promise.all(slow);

        expect(streaming.status).toBe(200);
    });

    test("still refuses a fifth open stream", async () =>
    {
        api = await startTestKernel({ plugins: [assistant] });
        await Promise.all([1, 2, 3, 4].map(() => handle(api!, { stream: true })));

        const fifth = await handle(api, { stream: true });

        expect(fifth.status).toBe(429);
    });
});

describe("a stream only its caller may see", () =>
{
    test("answers 500 rather than let a shared cache keep it", async () =>
    {
        api = await startTestKernel({ plugins: [assistant] });

        const answer = await handle(api, { stream: true, cache: "public, max-age=600" });

        expect(answer.status).toBe(500);
    });
});

describe("an error frame the handler cannot shape into JSON", () =>
{
    test("falls back to the neutral body, still as a data-only JSON frame its clients read", async () =>
    {
        const base = await serve();

        const text = await (await ask(base, { stream: true, fails: true, unshapedError: true })).text();
        const lines = text.split("\n").filter((line) => line.length > 0 && !line.startsWith(":"));

        expect(lines.every((line) => line.startsWith("data: "))).toBe(true);
        expect(lines.map((line) => JSON.parse(line.slice("data: ".length)) as unknown)).toContainEqual({ code: "INTERNAL", message: "The request could not be completed." });
        expect(text).not.toContain("[DONE]");
    });
});

describe("events a handler shapes beyond what the route declares", () =>
{
    test.each([
        ["a header outside sends", { header: "x-powered-by" }],
        ["a kit header", { header: "content-security-policy" }],
        ["a last frame on two lines", { end: "[DONE]\ndata: x" }],
        ["an empty last frame", { end: "" }],
    ])("answer 500 for %s, before any event", async (_what, extra) =>
    {
        api = await startTestKernel({ plugins: [assistant] });

        const answer = await api.kernel.handle({ method: "POST", path: "/messages", input: { stream: true, ...extra } });

        expect(answer.status).toBe(500);
    });
});

describe("the startup check", () =>
{
    const declaring = (extra: Record<string, unknown>) => definePlugin("either", {
        version: "1.0.0",
        describe: "Declares answers a test chooses.",
        routes: [route({
            method: "GET",
            path: "/either",
            describe: "Answers as the test declares.",
            public: true,
            limit: { requests: 10, seconds: 60 },
            input: z.object({}),
            handle: () => ({ text: "" }),
            ...extra,
        })],
    });

    test("accepts output and streams together", async () =>
    {
        api = await startTestKernel({ plugins: [declaring({ output: Answer, streams: Part })] });

        expect(api.kernel.started()).toBe(true);
    });

    test("still refuses an output that cannot filter beside streams", async () =>
    {
        await expect(startTestKernel({ plugins: [declaring({ output: z.record(z.string(), z.string()), streams: Part })] })).rejects.toThrow("output schema that cannot filter");
    });
});
