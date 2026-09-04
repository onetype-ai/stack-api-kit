import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, Refusal } from "../api";
import type { Caller, Definition, Kernel } from "../api";

/** A caller the test controls, as a project would build one. */
function calling(permissions: readonly string[] = [], id: string | undefined = "u1"): Caller
{
    return { id, permissions, claims: {} };
}

/** A kernel holding one plugin, started and ready to answer. */
async function serving(found: Partial<Definition>, lines: unknown[] = []): Promise<Kernel>
{
    const kernel = createKernel({
        plugins: [definePlugin("items", { version: "1.0.0", describe: "Owns items.", ...found } as Definition)],
        log: (level, plugin, line, about) =>
        {
            lines.push({ level, plugin, line, about });
        },
    });

    await kernel.start();

    return kernel;
}

describe("finding a route", () =>
{
    test("answers 404 for a path nothing declared", async () =>
    {
        const kernel = await serving({});

        const answered = await kernel.handle({ method: "GET", path: "/nope", input: {} });

        expect(answered.status).toBe(404);
    });

    test("answers 404 the same way whether or not the caller is signed in", async () =>
    {
        const kernel = await serving({});

        const anonymous = await kernel.handle({ method: "GET", path: "/nope", input: {} });
        const signedIn = await kernel.handle({ method: "GET", path: "/nope", input: {}, caller: calling() });

        expect(anonymous).toEqual(signedIn);
    });
});

describe("authentication", () =>
{
    test("refuses a caller with no id", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                input: z.object({}),
                output: z.object({}),
                handle: () => ({}),
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {} });

        expect(answered.status).toBe(401);
    });

    test("lets a public route through with no caller", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/health",
                describe: "Says the server is up.",
                public: true,
                input: z.object({}),
                output: z.object({ up: z.boolean() }),
                handle: () => ({ up: true }),
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/health", input: {} });

        expect(answered).toEqual({ status: 200, body: { up: true } });
    });

    test("never reaches the handler when the caller is refused", async () =>
    {
        let ran = false;
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                input: z.object({}),
                output: z.object({}),
                handle: () =>
                {
                    ran = true;

                    return {};
                },
            }],
        });

        await kernel.handle({ method: "GET", path: "/items", input: {} });

        expect(ran).toBe(false);
    });
});

describe("permissions", () =>
{
    const guarded: Partial<Definition> = {
        permissions: { "items.read": { describe: "See items." } },
        routes: [{
            method: "GET",
            path: "/items",
            describe: "Lists items.",
            requires: ["items.read"],
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handle: () => ({ ok: true }),
        }],
    };

    test("refuses a caller lacking the permission", async () =>
    {
        const kernel = await serving(guarded);

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {}, caller: calling() });

        expect(answered.status).toBe(403);
    });

    test("allows a caller carrying it", async () =>
    {
        const kernel = await serving(guarded);

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {}, caller: calling(["items.read"]) });

        expect(answered).toEqual({ status: 200, body: { ok: true } });
    });

    test("never names the permission a caller lacks", async () =>
    {
        const kernel = await serving(guarded);

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {}, caller: calling() });

        expect(JSON.stringify(answered.body)).not.toMatch(/items\.read/);
    });

    test("answers one caller without remembering the previous one", async () =>
    {
        const kernel = await serving(guarded);

        const allowed = await kernel.handle({ method: "GET", path: "/items", input: {}, caller: calling(["items.read"]) });
        const refused = await kernel.handle({ method: "GET", path: "/items", input: {}, caller: calling() });

        expect(allowed.status).toBe(200);
        expect(refused.status).toBe(403);
    });
});

describe("input", () =>
{
    const taking: Partial<Definition> = {
        routes: [{
            method: "POST",
            path: "/items",
            describe: "Creates an item.",
            public: true,
            input: z.object({ title: z.string().min(1).max(20) }),
            output: z.object({ title: z.string() }),
            handle: (input) => input as { title: string },
        }],
    };

    test("refuses a body failing the schema, naming the field", async () =>
    {
        const kernel = await serving(taking);

        const answered = await kernel.handle({ method: "POST", path: "/items", input: { title: "" } });

        expect(answered.status).toBe(400);
        expect(answered.body).toMatchObject({ code: "INVALID_INPUT", fields: { title: expect.any(String) } });
    });

    test("hands the handler only what the schema parsed", async () =>
    {
        let seen: unknown;
        const kernel = await serving({
            routes: [{
                method: "POST",
                path: "/items",
                describe: "Creates an item.",
                public: true,
                input: z.object({ title: z.string() }),
                output: z.object({}),
                handle: (input) =>
                {
                    seen = input;

                    return {};
                },
            }],
        });

        await kernel.handle({ method: "POST", path: "/items", input: { title: "a", admin: true } });

        expect(seen).toEqual({ title: "a" });
    });

    test("answers 201 for a POST that succeeded", async () =>
    {
        const kernel = await serving(taking);

        const answered = await kernel.handle({ method: "POST", path: "/items", input: { title: "one" } });

        expect(answered.status).toBe(201);
    });
});

describe("output", () =>
{
    test("drops what the output schema does not name", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/me",
                describe: "Answers the caller.",
                public: true,
                input: z.object({}),
                output: z.object({ id: z.string() }),
                handle: () => ({ id: "u1", passwordHash: "$2b$secret", email: "a@b.test" }),
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/me", input: {} });

        expect(answered.body).toEqual({ id: "u1" });
    });

    test("answers 500 rather than sending something the schema refuses", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/broken",
                describe: "Returns the wrong shape.",
                public: true,
                input: z.object({}),
                output: z.object({ id: z.string() }),
                handle: () => ({ id: 7 }),
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/broken", input: {} });

        expect(answered.status).toBe(500);
        expect(answered.body).toEqual({ code: "INTERNAL", message: "The request could not be completed." });
    });
});

describe("failures", () =>
{
    test("tells the caller nothing about a handler that threw", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                public: true,
                input: z.object({}),
                output: z.object({}),
                handle: () =>
                {
                    throw new Error("SQLITE_ERROR: no such column: users.secret_token");
                },
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {} });

        expect(answered.status).toBe(500);
        expect(JSON.stringify(answered.body)).not.toMatch(/SQLITE|secret_token|column/);
    });

    test("logs what it refused to tell the caller", async () =>
    {
        const lines: unknown[] = [];
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                public: true,
                input: z.object({}),
                output: z.object({}),
                handle: () =>
                {
                    throw new Error("no such column: users.secret_token");
                },
            }],
        }, lines);

        await kernel.handle({ method: "GET", path: "/items", input: {} });

        expect(JSON.stringify(lines)).toMatch(/secret_token/);
    });

    test("sends a Refusal exactly as the plugin wrote it", async () =>
    {
        const kernel = await serving({
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                public: true,
                input: z.object({}),
                output: z.object({}),
                handle: () =>
                {
                    throw new Refusal(409, "ITEM_LOCKED", "That item is being edited.");
                },
            }],
        });

        const answered = await kernel.handle({ method: "GET", path: "/items", input: {} });

        expect(answered).toEqual({ status: 409, body: { code: "ITEM_LOCKED", message: "That item is being edited." } });
    });
});
