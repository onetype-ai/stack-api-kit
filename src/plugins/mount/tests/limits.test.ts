import { describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute } from "../../kernel/api";
import { start } from "../api";

import type { Context } from "../../kernel/api";
import type { Budget } from "../../kernel/api";

const route = defineRoute<Context>();

/** One route nobody may call more than twice a minute. */
const bounded = definePlugin("bounded", {
    version: "1.0.0",
    describe: "Answers, twice a minute.",
    routes: [
        route({
            method: "GET", path: "/twice", describe: "Answers.", public: true,
            limit: { requests: 2, seconds: 60 },
            input: z.object({}), output: z.object({ ok: z.boolean() }),
            handle: () => ({ ok: true }),
        }),
    ],
});

async function ask(api: { fetch: (request: Request) => Response | Promise<Response> }, times: number)
{
    const answers: number[] = [];

    for (let at = 0; at < times; at += 1)
    {
        answers.push((await api.fetch(new Request("http://localhost/twice"))).status);
    }

    return answers;
}

describe("what a route's declared limit does", () =>
{
    test("counts by default, and the third request is refused", async () =>
    {
        const api = await start({ plugins: [bounded] });

        expect(await ask(api, 3)).toEqual([200, 200, 429]);

        await api.stop();
    });

    test("counts nothing when limits are off", async () =>
    {
        const api = await start({ plugins: [bounded], limits: false });

        expect(await ask(api, 5)).toEqual([200, 200, 200, 200, 200]);

        await api.stop();
    });

    test("and counts again when they are back on", async () =>
    {
        const api = await start({ plugins: [bounded], limits: true });

        expect(await ask(api, 3)).toEqual([200, 200, 429]);

        await api.stop();
    });
});

describe("turning them off", () =>
{
    test("says so loudly, because a quiet one becomes production", async () =>
    {
        const warnings: { line: string; about: unknown }[] = [];

        const api = await start({
            plugins: [bounded],
            limits: false,
            log: {
                debug: () => {}, info: () => {}, error: () => {},
                warn: (line, about) => { warnings.push({ line, about }); },
            },
        });

        expect(warnings.map((one) => one.line)).toContain("RATE LIMITS ARE NOT BEING COUNTED");

        await api.stop();
    });

    test("says nothing when they are on", async () =>
    {
        const warnings: string[] = [];

        const api = await start({
            plugins: [bounded],
            log: {
                debug: () => {}, info: () => {}, error: () => {},
                warn: (line) => { warnings.push(line); },
            },
        });

        expect(warnings).not.toContain("RATE LIMITS ARE NOT BEING COUNTED");

        await api.stop();
    });
});

describe("a public route nothing bounds", () =>
{
    /** Open to the world, and no budget said how often. */
    const open = definePlugin("open", {
        version: "1.0.0",
        describe: "Answers anyone, as often as they ask.",
        routes: [
            route({
                method: "POST", path: "/open", describe: "Answers.", public: true,
                input: z.object({}), output: z.object({ ok: z.boolean() }),
                handle: () => ({ ok: true }),
            }),
        ],
    });

    async function warningsFrom(plugins: Parameters<typeof start>[0]["plugins"])
    {
        const said: { line: string; about: unknown }[] = [];

        const api = await start({
            plugins,
            log: { debug: () => {}, info: () => {}, error: () => {}, warn: (line, about) => { said.push({ line, about }); } },
        });

        await api.stop();

        return said;
    }

    test("is named at boot, because public and unbounded is the whole internet", async () =>
    {
        const said = await warningsFrom([open]);
        const warned = said.find((one) => one.line === "PUBLIC ROUTES WITH NO LIMIT");

        expect(warned).toBeDefined();
        expect((warned?.about as { routes: string[] }).routes).toEqual(["open: POST /open"]);
    });

    test("says nothing about one that declares a limit", async () =>
    {
        const said = await warningsFrom([bounded]);

        expect(said.map((one) => one.line)).not.toContain("PUBLIC ROUTES WITH NO LIMIT");
    });

    test("says nothing about a route that is not public", async () =>
    {
        // A guarded route with no limit is the ordinary case: whoever reached
        // it was let through by name, and counting them is a separate choice.
        const guarded = definePlugin("guarded", {
            version: "1.0.0",
            describe: "Answers whoever was let in.",
            permissions: { "guarded.read": { describe: "Reads." } },
            routes: [
                route({
                    method: "GET", path: "/guarded", describe: "Answers.",
                    requires: ["guarded.read"],
                    input: z.object({}), output: z.object({ ok: z.boolean() }),
                    handle: () => ({ ok: true }),
                }),
            ],
        });

        const said = await warningsFrom([guarded]);

        expect(said.map((one) => one.line)).not.toContain("PUBLIC ROUTES WITH NO LIMIT");
    });
});

describe("a budget the project brought", () =>
{
    test("is used even where limits are off, since it was asked for by name", async () =>
    {
        const asked: string[] = [];

        const budget: Budget = {
            spend: (key) =>
            {
                asked.push(key);

                return { allowed: false, resetsIn: 42 };
            },
        };

        const api = await start({ plugins: [bounded], budget, limits: false });

        const answer = await api.fetch(new Request("http://localhost/twice"));

        expect(answer.status).toBe(429);
        expect(asked.length).toBe(1);

        await api.stop();
    });
});
