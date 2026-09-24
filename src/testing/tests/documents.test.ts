import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Refusal, Reply, Server, start } from "../../index";
import { createIdentity, startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { KernelResponse, StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";
import { testDatabase } from "./testDatabase";


const route = defineRoute();
const HTML = "<!doctype html><title>Widget</title>";

const pages = definePlugin("pages", {
    version: "1.0.0",
    describe: "Serves pages and a cacheable config.",
    routes: [
        route({
            method: "GET",
            path: "/page",
            describe: "A page nobody may frame.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            document: { policy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } },
            handle: () =>
            {
                return HTML;
            },
        }),
        route({
            method: "GET",
            path: "/frame/:site",
            describe: "A page one named site may frame.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({ site: z.string() }),
            document: { framable: true },
            handle: (input) =>
            {
                return Reply.document(HTML, {
                    policy: { defaultSrc: ["'self'"], frameAncestors: [`https://${input.site}.test`] },
                    etag: "rev-7",
                    headers: { "cache-control": "public, max-age=60", "set-cookie": "planted=1", "x-planted": "1" },
                });
            },
        }),
        route({
            method: "GET",
            path: "/sneaky",
            describe: "A page that tries to be framed without saying so.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            document: {},
            handle: () =>
            {
                return Reply.document(HTML, { policy: { frameAncestors: ["https://evil.test"] } });
            },
        }),
        route({
            method: "GET",
            path: "/missing",
            describe: "A page that is not there.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            document: {},
            handle: () =>
            {
                throw new Refusal(404, "NOT_FOUND", "No such page.");
            },
        }),
        route({
            method: "GET",
            path: "/json-page",
            describe: "A JSON route answering a document it never declared.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () =>
            {
                return Reply.document(HTML);
            },
        }),
        route({
            method: "GET",
            path: "/config",
            describe: "A config its editor compares by hash.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({ theme: z.string() }),
            handle: () =>
            {
                return new Reply(200, { theme: "blue" }, { etag: "config-hash-1", "cache-control": "public, max-age=60, stale-while-revalidate=600" });
            },
        }),
        route({
            method: "GET",
            path: "/plain",
            describe: "A JSON answer choosing nothing.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({ n: z.number() }),
            handle: () =>
            {
                return { n: 1 };
            },
        }),
        route({
            method: "POST",
            path: "/plain",
            describe: "A POST, which is never tagged.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({ n: z.number() }),
            handle: () =>
            {
                return { n: 1 };
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
});

const get = (path: string, ifNoneMatch?: string, method: "GET" | "POST" = "GET"): Promise<KernelResponse> =>
{
    return (api as TestKernel).kernel.handle({ method, path, input: {}, ...ifNoneMatch !== undefined && { ifNoneMatch } });
};

describe("a document route", () =>
{
    test("answers HTML under its own policy, unframable unless it says otherwise", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const page = await get("/page");

        expect(page.status).toBe(200);
        expect(page.body).toBe(HTML);
        expect(page.headers).toMatchObject({
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "cache-control": "no-cache",
            etag: expect.stringMatching(/^W\/"/),
        });
    });

    test("lets a framable route name who may frame it, per response, dropping headers a page may not set", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const frame = await get("/frame/shop");

        expect(frame.headers?.["content-security-policy"]).toBe("default-src 'self'; base-uri 'none'; frame-ancestors https://shop.test");
        expect(frame.headers?.["x-frame-options"]).toBeUndefined();
        expect(frame.headers?.["cache-control"]).toBe("public, max-age=60");
        expect(frame.headers?.["set-cookie"]).toBeUndefined();
        expect(frame.headers?.["x-planted"]).toBeUndefined();
        expect(frame.headers?.etag).toBe("\"rev-7\"");
    });

    test("refuses a page letting others frame it when the route never declared framable", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const sneaky = await get("/sneaky");

        expect(sneaky.status).toBe(500);
        expect(api.logLines.some((line) => line.line.includes("declare document: { framable: true }"))).toBe(true);
    });

    test("answers a refusal as the usual JSON body", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const missing = await get("/missing");

        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ code: "NOT_FOUND", message: "No such page." });
    });

    test("is the only kind of route that may answer one", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const wrong = await get("/json-page");

        expect(wrong.status).toBe(500);
        expect(api.logLines.some((line) => line.line.includes("answered a document, and declares no document"))).toBe(true);
    });
});

describe("a document policy", () =>
{
    const declaring = (document: Record<string, unknown>, extra: Record<string, unknown> = {}) => definePlugin("odd", {
        version: "1.0.0",
        describe: "Declares a page wrongly.",
        routes: [route({
            method: "GET",
            path: "/odd",
            describe: "Wrongly declared.",
            public: true,
            limit: { requests: 1, seconds: 1 },
            input: z.object({}),
            document,
            handle: () =>
            {
                return HTML;
            },
            ...extra,
        })],
    });

    test.each([
        ["a source smuggling a second directive", { scriptSrc: ["'self'; script-src *"] }, "separator or whitespace"],
        ["a source with a comma", { imgSrc: ["https://a.test,https://b.test"] }, "separator or whitespace"],
        ["'unsafe-eval' anywhere", { styleSrc: ["'unsafe-eval'"] }, "never sends"],
        ["'unsafe-inline' in scriptSrc", { scriptSrc: ["'unsafe-inline'"] }, "never sends"],
        ["a directive the kit does not write", { sandbox: ["allow-scripts"] }, "no directive the kit writes"],
        ["framing without framable", { frameAncestors: ["https://a.test"] }, "framable: true"],
    ])("is refused at startup with %s", async (_what, policy, reason) =>
    {
        const booting = startTestKernel({ plugins: [declaring({ policy })] });

        await expect(booting).rejects.toThrow(reason);
    });

    test("is refused at startup beside an output", async () =>
    {
        const booting = startTestKernel({ plugins: [declaring({}, { output: z.object({}) })] });

        await expect(booting).rejects.toThrow("declares output and document");
    });
});

describe("a GET's ETag", () =>
{
    test("is a hash of what it sends when the reply chose none, and a match answers 304 with no body", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const first = await get("/plain");
        const again = await get("/plain", first.headers?.etag);

        expect(first.headers?.etag).toMatch(/^W\/"/);
        expect(again.status).toBe(304);
        expect(again.body).toBeNull();
    });

    test("is the one the reply chose, compared weakly, in a list, or as *", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const fresh = await get("/config");
        const listed = await get("/config", "\"other\", W/\"config-hash-1\"");
        const any = await get("/config", "*");
        const stale = await get("/config", "\"config-hash-0\"");

        expect(fresh.headers?.etag).toBe("\"config-hash-1\"");
        expect(listed).toEqual({ status: 304, body: null, headers: { etag: "\"config-hash-1\"", "cache-control": "public, max-age=60, stale-while-revalidate=600" } });
        expect(any.status).toBe(304);
        expect(stale.status).toBe(200);
    });

    test("is never put on a POST", async () =>
    {
        api = await startTestKernel({ plugins: [pages] });

        const posted = await get("/plain", "*", "POST");

        expect(posted.status).toBe(201);
        expect(posted.headers?.etag).toBeUndefined();
    });
});

describe("over HTTP", () =>
{
    const serve = async (): Promise<string> =>
    {
        app = await start({ plugins: [pages], database: await testDatabase(), sockets: false });
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

    test("a page keeps its policy and a JSON reply its cache-control; the defaults fill only the rest", async () =>
    {
        const base = await serve();

        const page = await fetch(`${base}/frame/shop`, { headers: { connection: "close" } });
        const config = await fetch(`${base}/config`, { headers: { connection: "close" } });
        const plain = await fetch(`${base}/plain`, { headers: { connection: "close" } });

        expect(await page.text()).toBe(HTML);
        expect(page.headers.get("content-security-policy")).toBe("default-src 'self'; base-uri 'none'; frame-ancestors https://shop.test");
        expect(page.headers.get("x-frame-options")).toBeNull();
        expect(config.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=600");
        expect(plain.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(plain.headers.get("x-frame-options")).toBe("DENY");
        expect(plain.headers.get("cache-control")).toBe("no-store");
    });

    // 04's widget review: a browser updates the headers it stored for a page from a
    // 304, so a revalidated frame must keep the policy that lets its site frame it.
    test("a revalidated page keeps its own policy and framing, not the kit's defaults", async () =>
    {
        const base = await serve();

        const first = await fetch(`${base}/frame/shop`, { headers: { connection: "close" } });
        const again = await fetch(`${base}/frame/shop`, { headers: { connection: "close", "if-none-match": first.headers.get("etag") ?? "" } });

        expect(again.status).toBe(304);
        expect(again.headers.get("content-security-policy")).toBe("default-src 'self'; base-uri 'none'; frame-ancestors https://shop.test");
        expect(again.headers.get("x-frame-options")).toBeNull();
        expect(again.headers.get("cache-control")).toBe("public, max-age=60");
    });

    test("a revalidated unframable page stays unframable under its own policy", async () =>
    {
        const base = await serve();

        const first = await fetch(`${base}/page`, { headers: { connection: "close" } });
        const again = await fetch(`${base}/page`, { headers: { connection: "close", "if-none-match": first.headers.get("etag") ?? "" } });

        expect(again.status).toBe(304);
        expect(again.headers.get("content-security-policy")).toBe(first.headers.get("content-security-policy"));
        expect(again.headers.get("x-frame-options")).toBe("DENY");
    });

    test("a matching If-None-Match answers 304 with an empty body", async () =>
    {
        const base = await serve();

        const response = await fetch(`${base}/config`, { headers: { connection: "close", "if-none-match": "\"config-hash-1\"" } });

        expect(response.status).toBe(304);
        expect(await response.text()).toBe("");
        expect(response.headers.get("etag")).toBe("\"config-hash-1\"");
    });
});

// c7's review of 3b: a route that is not a document may not weaken how a browser
// treats its answer, nor answer HTML by naming a content type.
const WEAKENING: Readonly<Record<string, string>> = {
    "referrer-policy": "unsafe-url",
    "strict-transport-security": "max-age=0",
    "content-security-policy": "default-src *",
    "content-security-policy-report-only": "default-src *",
    "permissions-policy": "camera=*",
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    "content-type": "text/html",
    "x-frame-options": "ALLOWALL",
    "x-content-type-options": "none",
    "set-cookie": "planted=1",
    "x-custom": "1",
};

const KEPT: Readonly<Record<string, string>> = {
    location: "/somewhere",
    "retry-after": "5",
    vary: "Accept",
    "content-disposition": "attachment; filename=\"a.csv\"",
    "x-session-end": "1",
};

const headers = definePlugin("headers", {
    version: "1.0.0",
    describe: "Routes that try to set what they may not.",
    routes: [
        route({
            method: "GET",
            path: "/weaken",
            describe: "Sets every header it may not, beside those it may.",
            requires: [],
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () =>
            {
                return new Reply(200, {}, { ...WEAKENING, ...KEPT, "cache-control": "public, max-age=600" });
            },
        }),
        route({
            method: "GET",
            path: "/shared",
            describe: "A public route, which a shared cache may keep.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () =>
            {
                return new Reply(200, {}, { "cache-control": "public, max-age=600" });
            },
        }),
        route({
            method: "POST",
            path: "/replay",
            describe: "Names the one extra header it sends.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            sends: ["idempotent-replayed"],
            handle: () =>
            {
                return new Reply(200, {}, { "idempotent-replayed": "true" });
            },
        }),
        route({
            method: "GET",
            path: "/raw",
            describe: "A JSON route answering markup as a string.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.string(),
            handle: () =>
            {
                return "<script>alert(1)</script>";
            },
        }),
    ],
});

describe("a reply's own headers", () =>
{
    test.each(Object.keys(WEAKENING))("drops %s from a route that is not a document", async (name) =>
    {
        api = await startTestKernel({ plugins: [headers], strictReplyHeaders: true });

        const answer = await api.kernel.handle({ method: "GET", path: "/weaken", input: {}, identity: createIdentity([], "ana") });

        expect(answer.headers?.[name]).toBeUndefined();
    });

    test("keeps what a reply may say about itself", async () =>
    {
        api = await startTestKernel({ plugins: [headers], strictReplyHeaders: true });

        const answer = await api.kernel.handle({ method: "GET", path: "/weaken", input: {}, identity: createIdentity([], "ana") });

        expect(answer.headers).toMatchObject(KEPT);
    });

    test("lets only a public route hand its answer to a shared cache", async () =>
    {
        api = await startTestKernel({ plugins: [headers], strictReplyHeaders: true });

        const personal = await api.kernel.handle({ method: "GET", path: "/weaken", input: {}, identity: createIdentity([], "ana") });
        const shared = await api.kernel.handle({ method: "GET", path: "/shared", input: {} });

        expect(personal.headers?.["cache-control"]).toBeUndefined();
        expect(shared.headers?.["cache-control"]).toBe("public, max-age=600");
    });

    test("keeps a header the route names in sends", async () =>
    {
        api = await startTestKernel({ plugins: [headers], strictReplyHeaders: true });

        const answer = await api.kernel.handle({ method: "POST", path: "/replay", input: {} });

        expect(answer.headers?.["idempotent-replayed"]).toBe("true");
    });

    test.each(["referrer-policy", "cross-origin-opener-policy", "access-control-allow-origin", "X-Upper"])("refuses at startup a route that sends %s", async (header) =>
    {
        const sending = definePlugin("odd", {
            version: "1.0.0",
            describe: "Declares a header it may not send.",
            routes: [route({ method: "GET", path: "/odd", describe: "Sends too much.", public: true, limit: { requests: 1, seconds: 1 }, input: z.object({}), output: z.object({}), sends: [header], handle: () => ({}) })],
        });

        await expect(startTestKernel({ plugins: [sending] })).rejects.toThrow(`sends "${header}"`);
    });
});

describe("over HTTP, a route that is not a document", () =>
{
    const serveHeaders = async (): Promise<string> =>
    {
        app = await start({ plugins: [headers], database: await testDatabase(), sockets: false, strictReplyHeaders: true, identify: () => () => createIdentity([], "ana") });
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

    test("carries the kit's security headers whatever it tried", async () =>
    {
        const base = await serveHeaders();

        const response = await fetch(`${base}/weaken`, { headers: { connection: "close" } });

        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("strict-transport-security")).toBeNull();
        expect(response.headers.get("permissions-policy")).toBeNull();
        expect(response.headers.get("content-type")).toContain("application/json");
    });

    test("answers markup as a JSON string, never as HTML", async () =>
    {
        const base = await serveHeaders();

        const response = await fetch(`${base}/raw`, { headers: { connection: "close" } });

        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.text()).toBe("\"<script>alert(1)</script>\"");
    });
});

describe("a document beside another answer", () =>
{
    test.each([
        ["streams", { streams: z.object({ text: z.string() }) }],
        ["output", { output: z.object({ text: z.string() }) }],
    ])("is refused at startup beside %s", async (other, answer) =>
    {
        const both = definePlugin("pages", {
            version: "1.0.0",
            describe: "Declares two ways to answer.",
            routes: [route({ method: "GET", path: "/page", describe: "A page.", public: true, limit: { requests: 1, seconds: 1 }, input: z.object({}), document: {}, ...answer, handle: () => "<p>hi</p>" })],
        });

        await expect(startTestKernel({ plugins: [both] })).rejects.toThrow(other === "output" ? "declares output and document" : "declares streams and document");
    });
});
