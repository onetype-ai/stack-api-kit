import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Server, start } from "../../index";
import { createIdentity, startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { StartedApp } from "../../index";
import { testDatabase } from "./testDatabase";


const route = defineRoute();
const TRUSTED = "https://app.example.test";
const CUSTOMER = "https://shop.example";

let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

const look = definePlugin("look", {
    version: "1.0.0",
    describe: "Serves a launcher's look to any site, and changes it only for its owner.",
    permissions: { "look.write": { describe: "Change the look." } },
    routes: [
        route({
            method: "GET",
            path: "/look/:agentId",
            describe: "The launcher's look, the same for everyone.",
            public: true,
            anyOrigin: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({ agentId: z.string() }),
            output: z.object({ color: z.string(), seenAs: z.string().nullable() }),
            handle: (_input, ctx) => ({ color: "teal", seenAs: ctx.identity?.id ?? null }),
        }),
        route({
            method: "PUT",
            path: "/look/:agentId",
            describe: "Changes the look.",
            requires: ["look.write"],
            input: z.object({ agentId: z.string() }),
            output: z.object({}),
            handle: () => ({}),
        }),
        route({
            method: "GET",
            path: "/private",
            describe: "Answers only the dashboard.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () => ({}),
        }),
    ],
});

const serve = async (): Promise<string> =>
{
    app = await start({ plugins: [look], database: await testDatabase(), sockets: false, http: { origins: [TRUSTED] }, identify: () => () => createIdentity(["look.write"], "ana") });
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

const from = (origin: string, extra: Record<string, string> = {}): Record<string, string> =>
{
    return { connection: "close", origin, cookie: "session=ana", ...extra };
};

describe("a route any site may read", () =>
{
    test("answers every origin with *, never with credentials, never as the signed-in caller, and varies by Origin for caches", async () =>
    {
        const base = await serve();

        const response = await fetch(`${base}/look/agent-1`, { headers: from(CUSTOMER) });

        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        expect(response.headers.get("vary")).toContain("Origin");
        expect(await response.json()).toEqual({ color: "teal", seenAs: null });
    });

    test("answers a HEAD the same way", async () =>
    {
        const base = await serve();

        const response = await fetch(`${base}/look/agent-1`, { method: "HEAD", headers: from(CUSTOMER) });

        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    test("allows a preflight for reading it, and never for the write at the same path", async () =>
    {
        const base = await serve();

        const reading = await fetch(`${base}/look/agent-1`, { method: "OPTIONS", headers: from(CUSTOMER, { "access-control-request-method": "GET" }) });
        const writing = await fetch(`${base}/look/agent-1`, { method: "OPTIONS", headers: from(CUSTOMER, { "access-control-request-method": "PUT" }) });

        expect(reading.status).toBe(204);
        expect(reading.headers.get("access-control-allow-origin")).toBe("*");
        expect(reading.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
        expect(reading.headers.get("access-control-allow-credentials")).toBeNull();
        expect(writing.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("a route that did not ask for it", () =>
{
    test("still answers only the trusted origins, with credentials, as before", async () =>
    {
        const base = await serve();

        const customer = await fetch(`${base}/private`, { headers: from(CUSTOMER) });
        const trusted = await fetch(`${base}/private`, { headers: from(TRUSTED) });

        expect(customer.headers.get("access-control-allow-origin")).toBeNull();
        expect(trusted.headers.get("access-control-allow-origin")).toBe(TRUSTED);
        expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    });
});

describe("a route that may not let any site read it", () =>
{
    const booting = (declared: Record<string, unknown>): Promise<unknown> =>
    {
        const odd = definePlugin("odd", {
            version: "1.0.0",
            describe: "Declares anyOrigin where it does not belong.",
            permissions: { "odd.read": { describe: "Read." } },
            routes: [route({ method: "GET", path: "/odd", describe: "Odd.", public: true, anyOrigin: true, limit: { requests: 1, seconds: 1 }, input: z.object({}), output: z.object({}), handle: () => ({}), ...declared } as never)],
        });

        return startTestKernel({ plugins: [odd] });
    };

    test.each([
        ["a write", { method: "POST" }, "only a public GET may"],
        ["one that needs a signed-in caller", { public: false, requires: ["odd.read"] }, "only a public GET may"],
        ["one reading the session cookie", { reads: ["cookie"] }, "reads a credential header"],
        ["one reading a bearer token", { reads: ["authorization"] }, "reads a credential header"],
    ])("is refused at startup for %s", async (_what, declared, reason) =>
    {
        await expect(booting(declared)).rejects.toThrow(reason);
    });
});
