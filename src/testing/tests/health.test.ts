import { afterEach, describe, expect, test } from "vitest";

import { definePlugin, start } from "../../index";

import type { StartedApp } from "../../index";
import { testDatabase } from "./testDatabase";


let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

const quiet = definePlugin("quiet", { version: "1.0.0", describe: "Declares nothing." });

const boot = async (readiness?: () => Promise<{ ready: boolean } & Record<string, unknown>>): Promise<StartedApp> =>
{
    app = await start({ plugins: [quiet], database: await testDatabase(), sockets: false, http: { ...(readiness !== undefined && { readiness }) } });

    return app;
};

const get = (running: StartedApp, path: string): Promise<Response> =>
{
    return Promise.resolve(running.fetch(new Request(`http://api.test${path}`)));
};

describe("GET /health", () =>
{
    test("answers that the process serves, naming nothing, whatever readiness says", async () =>
    {
        const running = await boot(() => Promise.resolve({ ready: false }));

        const response = await get(running, "/health");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ live: true });
    });
});

describe("GET /ready", () =>
{
    test("answers 200 with what the project checked when it is ready", async () =>
    {
        const running = await boot(() => Promise.resolve({ ready: true, components: { database: "ok", search: "ok" } }));

        const response = await get(running, "/ready");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ready: true, components: { database: "ok", search: "ok" } });
    });

    test("answers 503 when a component is down", async () =>
    {
        const running = await boot(() => Promise.resolve({ ready: false, components: { database: "ok", search: "down" } }));

        const response = await get(running, "/ready");

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ready: false, components: { database: "ok", search: "down" } });
    });

    test("answers 503 and nothing of the cause when the check throws", async () =>
    {
        const running = await boot(() => Promise.reject(new Error("connect ECONNREFUSED qdrant.internal:6333")));

        const response = await get(running, "/ready");
        const body = await response.text();

        expect(response.status).toBe(503);
        expect(body).toBe("{\"ready\":false}");
    });

    test("answers whether the kernel started when the project checks nothing", async () =>
    {
        const running = await boot();

        const response = await get(running, "/ready");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ready: true });
    });
});
