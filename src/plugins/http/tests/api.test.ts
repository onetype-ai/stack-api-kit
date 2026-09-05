import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Answered, createKernel, definePlugin } from "../../kernel/api";
import type { Caller, Definition, Kernel } from "../../kernel/api";
import { identifier, serve, type ServerOptions } from "../api";

async function serving(found: Partial<Definition> = {}, options: Partial<ServerOptions> = {}): Promise<ReturnType<typeof serve>>
{
    const kernel: Kernel = createKernel({
        plugins: [definePlugin("items", { version: "1.0.0", describe: "Owns items.", ...found } as Definition)],
    });

    await kernel.start();

    return serve({ kernel, ...options });
}

const listing: Partial<Definition> = {
    routes: [{
        method: "GET",
        path: "/items",
        describe: "Lists items.",
        public: true,
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handle: () => ({ ok: true }),
    }],
};

const taking: Partial<Definition> = {
    routes: [{
        method: "POST",
        path: "/items",
        describe: "Creates an item.",
        public: true,
        input: z.object({ title: z.string().min(1) }),
        output: z.object({ title: z.string() }),
        handle: (input) => input as { title: string },
    }],
};

describe("headers", () =>
{
    test("carries the security headers on every answer", async () =>
    {
        const app = await serving(listing);

        const answer = await app.request("/items");

        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        expect(answer.headers.get("x-frame-options")).toBe("DENY");
        expect(answer.headers.get("cache-control")).toBe("no-store");
        expect(answer.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    });

    test("carries them on a refusal too", async () =>
    {
        const app = await serving(listing);

        const answer = await app.request("/nothing");

        expect(answer.status).toBe(404);
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("answers with a request id, and keeps the one it was sent", async () =>
    {
        const app = await serving(listing);

        const made = await app.request("/items");
        const kept = await app.request("/items", { headers: { "x-request-id": "abc-123" } });

        expect(made.headers.get("x-request-id")).toMatch(/.+/);
        expect(kept.headers.get("x-request-id")).toBe("abc-123");
    });

    test("refuses a request id shaped to be written into a log as a second line", () =>
    {
        const kept = identifier("abc-123");
        const replaced = identifier("a\nlevel=error fake");

        expect(kept).toBe("abc-123");
        expect(replaced).not.toMatch(/\n/);
        expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe("origins", () =>
{
    test("allows one it was given", async () =>
    {
        const app = await serving(listing, { origins: ["https://app.example.test"] });

        const answer = await app.request("/items", { headers: { origin: "https://app.example.test" } });

        expect(answer.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
        expect(answer.headers.get("vary")).toBe("Origin");
    });

    test("never echoes one it was not given", async () =>
    {
        const app = await serving(listing, { origins: ["https://app.example.test"] });

        const answer = await app.request("/items", { headers: { origin: "https://evil.test" } });

        expect(answer.headers.get("access-control-allow-origin")).toBeNull();
    });

    test("says the answer varies by origin even when the origin is refused", async () =>
    {
        const app = await serving(listing, { origins: ["https://app.example.test"] });

        const refused = await app.request("/items", { headers: { origin: "https://evil.test" } });
        const none = await app.request("/items");

        expect(refused.headers.get("vary")).toBe("Origin");
        expect(none.headers.get("vary")).toBe("Origin");
    });

    test("answers a preflight for a path some route declares", async () =>
    {
        const app = await serving(listing, { origins: ["https://app.example.test"] });

        const answer = await app.request("/items", {
            method: "OPTIONS",
            headers: { origin: "https://app.example.test" },
        });

        expect(answer.status).toBe(204);
        expect(answer.headers.get("access-control-allow-methods")).toBe("GET");
    });

    test("refuses a preflight for a path nothing declares", async () =>
    {
        const app = await serving(listing, { origins: ["https://app.example.test"] });

        const answer = await app.request("/no-such-route", {
            method: "OPTIONS",
            headers: { origin: "https://app.example.test" },
        });

        expect(answer.status).toBe(404);
    });

    test("names only the methods the path actually answers", async () =>
    {
        const app = await serving({
            routes: [
                { method: "GET", path: "/items", describe: "Lists.", public: true, input: z.object({}), output: z.object({}), handle: () => ({}) },
                { method: "POST", path: "/items", describe: "Creates.", public: true, input: z.object({}), output: z.object({}), handle: () => ({}) },
                { method: "DELETE", path: "/other", describe: "Removes.", public: true, input: z.object({}), output: z.object({}), handle: () => ({}) },
            ],
        }, { origins: ["https://app.example.test"] });

        const answer = await app.request("/items", {
            method: "OPTIONS",
            headers: { origin: "https://app.example.test" },
        });

        expect(answer.headers.get("access-control-allow-methods")).toBe("GET, POST");
    });

    test("answers a preflight for a path holding a parameter", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/items/:id",
                describe: "Answers one.",
                public: true,
                input: z.object({ id: z.string() }),
                output: z.object({}),
                handle: () => ({}),
            }],
        }, { origins: ["https://app.example.test"] });

        const answer = await app.request("/items/abc", {
            method: "OPTIONS",
            headers: { origin: "https://app.example.test" },
        });

        expect(answer.status).toBe(204);
    });
});

describe("query parameters", () =>
{
    const asking: Partial<Definition> = {
        routes: [{
            method: "GET",
            path: "/items",
            describe: "Lists items.",
            public: true,
            input: z.object({ q: z.string(), page: z.coerce.number().default(1) }),
            output: z.object({ q: z.string(), page: z.number() }),
            handle: (input) => input as { q: string; page: number },
        }],
    };

    test("hands one value to a schema expecting one value", async () =>
    {
        const app = await serving(asking);

        const answer = await app.request("/items?q=hello");

        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ q: "hello", page: 1 });
    });

    test("hands a repeated parameter over as a list", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                public: true,
                input: z.object({ tag: z.array(z.string()) }),
                output: z.object({ tag: z.array(z.string()) }),
                handle: (input) => input as { tag: string[] },
            }],
        });

        const answer = await app.request("/items?tag=a&tag=b");

        expect(await answer.json()).toEqual({ tag: ["a", "b"] });
    });

    test("lets a coerced number arrive as the string a query carries", async () =>
    {
        const app = await serving(asking);

        const answer = await app.request("/items?q=hello&page=3");

        expect(await answer.json()).toEqual({ q: "hello", page: 3 });
    });

    test("drops a query key that would reach Object.prototype", async () =>
    {
        const app = await serving(asking);

        await app.request("/items?q=hello&__proto__=polluted");

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe("bodies", () =>
{
    test("refuses a body larger than the limit", async () =>
    {
        const app = await serving(taking, { bodyBytes: 100 });

        const answer = await app.request("/items", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "x".repeat(500) }),
        });

        expect(answer.status).toBe(413);
    });

    // A chunked request sends no content-length, so the claim cannot be
    // checked: the bytes are counted as they arrive, and the rest is never
    // asked for. Buffering it whole first would spend the memory a caller
    // was about to be refused for asking to spend.
    test("and stops reading one that arrives without saying how big it is", async () =>
    {
        const app = await serving(taking, { bodyBytes: 100 });

        let sent = 0;

        const body = new ReadableStream<Uint8Array>({
            pull(held)
            {
                sent += 1;

                if (sent > 50)
                {
                    held.close();
                    return;
                }

                held.enqueue(new TextEncoder().encode("x".repeat(100)));
            },
        });

        const answer = await app.request("/items", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            duplex: "half",
        } as RequestInit);

        expect(answer.status).toBe(413);
        expect(sent).toBeLessThan(10);
    });

    test("refuses a body that is not JSON", async () =>
    {
        const app = await serving(taking);

        const answer = await app.request("/items", { method: "POST", body: "{ broken" });

        expect(answer.status).toBe(400);
        expect(await answer.json()).toMatchObject({ code: "INVALID_JSON" });
    });

    test("bounds a DELETE body like any other", async () =>
    {
        const app = await serving({
            routes: [{
                method: "DELETE",
                path: "/items",
                describe: "Removes items.",
                public: true,
                input: z.object({}),
                output: z.object({}),
                handle: () => ({}),
            }],
        }, { bodyBytes: 100 });

        const answer = await app.request("/items", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ padding: "x".repeat(500) }),
        });

        expect(answer.status).toBe(413);
    });

    test("takes a body the schema accepts", async () =>
    {
        const app = await serving(taking);

        const answer = await app.request("/items", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "One" }),
        });

        expect(answer.status).toBe(201);
        expect(await answer.json()).toEqual({ title: "One" });
    });
});

describe("input", () =>
{
    test("hands a path parameter to the schema", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/items/:id",
                describe: "Answers one item.",
                public: true,
                input: z.object({ id: z.string() }),
                output: z.object({ id: z.string() }),
                handle: (input) => input as { id: string },
            }],
        });

        const answer = await app.request("/items/abc");

        expect(await answer.json()).toEqual({ id: "abc" });
    });

    test("never lets a body override the path it was sent to", async () =>
    {
        const app = await serving({
            routes: [{
                method: "POST",
                path: "/items/:id",
                describe: "Writes one item.",
                public: true,
                input: z.object({ id: z.string() }),
                output: z.object({ id: z.string() }),
                handle: (input) => input as { id: string },
            }],
        });

        const answer = await app.request("/items/mine", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "yours" }),
        });

        expect(await answer.json()).toEqual({ id: "mine" });
    });

    test("drops a body key that would reach Object.prototype", async () =>
    {
        const app = await serving({
            routes: [{
                method: "POST",
                path: "/items",
                describe: "Creates an item.",
                public: true,
                input: z.object({ title: z.string() }),
                output: z.object({ title: z.string() }),
                handle: (input) => input as { title: string },
            }],
        });

        await app.request("/items", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"title":"One","__proto__":{"polluted":true}}',
        });

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe("an answer carrying its own status", () =>
{
    test("reaches the wire as a redirect a client can follow", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/go",
                describe: "Sends the caller onward.",
                public: true,
                input: z.object({}),
                output: z.object({ to: z.string() }),
                handle: () => Answered.redirect("https://example.test/target"),
            }],
        });

        const answer = await app.request("/go", { redirect: "manual" });

        expect(answer.status).toBe(307);
        expect(answer.headers.get("location")).toBe("https://example.test/target");
    });

    test("carries a header a route set, alongside the ones the kit sets", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/thing",
                describe: "Answers with a tag.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.literal(true) }),
                handle: () => new Answered(200, { ok: true as const }, { etag: '"abc"' }),
            }],
        });

        const answer = await app.request("/thing");

        expect(answer.headers.get("etag")).toBe('"abc"');
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("never lets a route override what the kit answers for", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/thing",
                describe: "Tries to weaken the response.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.literal(true) }),
                handle: () => new Answered(200, { ok: true as const }, {
                    "x-frame-options": "ALLOWALL",
                    "set-cookie": "session=stolen",
                }),
            }],
        });

        const answer = await app.request("/thing");

        expect(answer.headers.get("x-frame-options")).toBe("DENY");
        expect(answer.headers.get("set-cookie")).toBeNull();
    });
});

describe("headers a route declared", () =>
{
    const reading: Partial<Definition> = {
        routes: [{
            method: "GET",
            path: "/thing",
            describe: "Answers what it read.",
            public: true,
            reads: ["accept-language"],
            input: z.object({}),
            output: z.object({ language: z.string(), seen: z.array(z.string()) }),
            handle: (_input, ctx) => ({
                language: ctx.headers["accept-language"] ?? "",
                seen: Object.keys(ctx.headers).sort(),
            }),
        }],
    };

    test("reaches the handler off a real request", async () =>
    {
        const app = await serving(reading);

        const answer = await app.request("/thing", { headers: { "accept-language": "ja,en;q=0.8" } });

        expect(await answer.json()).toEqual({ language: "ja,en;q=0.8", seen: ["accept-language"] });
    });

    test("matches however the caller cased the name", async () =>
    {
        const app = await serving(reading);

        const answer = await app.request("/thing", { headers: { "Accept-Language": "de" } });

        expect(await answer.json()).toMatchObject({ language: "de" });
    });

    test("never carries a header the route did not declare", async () =>
    {
        const app = await serving(reading);

        const answer = await app.request("/thing", {
            headers: { "accept-language": "en", cookie: "session=secret", "x-trace": "abc" },
        });

        const body = await answer.json() as { seen: string[] };

        expect(body.seen).toEqual(["accept-language"]);
        expect(JSON.stringify(body)).not.toMatch(/secret/);
    });
});

describe("callers", () =>
{
    test("answers 401 when identify throws rather than 500", async () =>
    {
        const app = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                input: z.object({}),
                output: z.object({}),
                handle: () => ({}),
            }],
        }, {
            identify: () =>
            {
                throw new Error("the token store is down");
            },
        });

        const answer = await app.request("/items");

        expect(answer.status).toBe(401);
        expect(JSON.stringify(await answer.json())).not.toMatch(/token store/);
    });

    test("passes the caller identify returned to the kernel", async () =>
    {
        const caller: Caller = { id: "u1", permissions: ["items.read"], claims: {} };
        const app = await serving({
            permissions: { "items.read": { describe: "See items." } },
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                requires: ["items.read"],
                input: z.object({}),
                output: z.object({ id: z.string() }),
                handle: (_input, ctx) => ({ id: ctx.caller?.id ?? "" }),
            }],
        }, { identify: () => caller });

        const answer = await app.request("/items");

        expect(await answer.json()).toEqual({ id: "u1" });
    });
});
