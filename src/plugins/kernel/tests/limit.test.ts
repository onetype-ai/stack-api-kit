import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import type { Caller, Definition, Options, Plugin } from "../api";
import { limiter } from "../../guard/api";

function budgetOf(limit?: { requests: number; seconds: number }): Plugin
{
    return definePlugin("probe", {
        version: "1.0.0",
        describe: "Answers within a budget.",
        routes: [{
            method: "GET",
            path: "/thing",
            describe: "Answers.",
            public: true,
            input: z.object({}),
            output: z.object({ ok: z.literal(true) }),
            ...(limit !== undefined && { limit }),
            handle: () => ({ ok: true as const }),
        }],
    } as Definition);
}

function createCaller(id: string): Caller
{
    return { id, permissions: [], claims: {} };
}

async function started(options: Partial<Options> & { plugins: readonly Plugin[] })
{
    const kernel = createKernel({ budget: limiter(), ...options });

    await kernel.start();

    return kernel;
}

describe("a declared budget", () =>
{
    test("refuses once it is spent, and says how long to wait", async () =>
    {
        const kernel = await started({ plugins: [budgetOf({ requests: 3, seconds: 60 })] });

        const answers = [];

        for (let at = 0; at < 5; at += 1)
        {
            answers.push(await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" }));
        }

        expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 429, 429]);
        expect(answers[3]?.body).toMatchObject({ code: "RATE_LIMITED" });
        expect(answers[3]?.headers).toMatchObject({ "retry-after": expect.any(String) });
    });

    test("counts each caller apart, so one flood does not spend another's", async () =>
    {
        const kernel = await started({ plugins: [budgetOf({ requests: 1, seconds: 60 })] });

        await kernel.handle({ method: "GET", path: "/thing", input: {}, caller: createCaller("u1") });

        const flooded = await kernel.handle({ method: "GET", path: "/thing", input: {}, caller: createCaller("u1") });
        const other = await kernel.handle({ method: "GET", path: "/thing", input: {}, caller: createCaller("u2") });

        expect(flooded.status).toBe(429);
        expect(other.status).toBe(200);
    });

    test("never reaches the handler once the budget is spent", async () =>
    {
        let ran = 0;

        const kernel = await started({
            plugins: [definePlugin("probe", {
                version: "1.0.0",
                describe: "Counts how often it ran.",
                routes: [{
                    method: "GET",
                    path: "/thing",
                    describe: "Answers.",
                    public: true,
                    input: z.object({}),
                    output: z.object({ ok: z.literal(true) }),
                    limit: { requests: 1, seconds: 60 },
                    handle: () =>
                    {
                        ran += 1;

                        return { ok: true as const };
                    },
                }],
            } as Definition)],
        });

        await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" });
        await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" });

        expect(ran).toBe(1);
    });

    test("leaves a route with no limit alone", async () =>
    {
        const kernel = await started({ plugins: [budgetOf()] });

        const answers = [];

        for (let at = 0; at < 50; at += 1)
        {
            answers.push(await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" }));
        }

        expect(answers.every((answer) => answer.status === 200)).toBe(true);
    });
});

describe("a budget that would enforce nothing", () =>
{
    test("refuses to start when a route declares a limit and no budget was given", async () =>
    {
        const kernel = createKernel({ plugins: [budgetOf({ requests: 5, seconds: 60 })] });

        const failed = await kernel.start().then(() => undefined).catch((cause: unknown) => cause as Error);

        expect(failed?.message).toMatch(/no budget was given/);
        expect(failed?.message).toMatch(/GET \/thing/);
    });

    test("starts without a budget when no route declares a limit", async () =>
    {
        const kernel = createKernel({ plugins: [budgetOf()] });

        await expect(kernel.start()).resolves.toBeUndefined();
    });

    test("refuses a budget under one request", async () =>
    {
        const kernel = await started({ plugins: [budgetOf({ requests: 0, seconds: 60 })] }).catch((cause: unknown) => cause as Error);

        expect((kernel as Error).message).toMatch(/refuses everything/);
    });

    test("refuses a window with no length", async () =>
    {
        const kernel = await started({ plugins: [budgetOf({ requests: 5, seconds: 0 })] }).catch((cause: unknown) => cause as Error);

        expect((kernel as Error).message).toMatch(/never resets/);
    });
});
