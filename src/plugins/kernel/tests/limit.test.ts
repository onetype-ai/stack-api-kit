import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Refusal, Reply, createKernel, definePlugin } from "../api";
import type { Identity, Definition, KernelOptions, Plugin } from "../api";
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

function createIdentity(id: string): Identity
{
    return { id, permissions: [], claims: {} };
}

async function startKernel(options: Partial<KernelOptions> & { plugins: readonly Plugin[] })
{
    const kernel = createKernel({ rateLimiter: limiter(), ...options });

    await kernel.start();

    return kernel;
}

describe("a declared budget", () =>
{
    test("refuses once it is spent, and says how long to wait", async () =>
    {
        const kernel = await startKernel({ plugins: [budgetOf({ requests: 3, seconds: 60 })] });

        const answers = [];

        for (let at = 0; at < 5; at += 1)
        {
            answers.push(await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" }));
        }

        expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 429, 429]);
        expect(answers[3]?.body).toMatchObject({ code: "RATE_LIMITED" });
        expect(answers[3]?.headers).toMatchObject({ "retry-after": expect.any(String) });
    });

    test("counts each identity apart, so one flood does not spend another's", async () =>
    {
        const kernel = await startKernel({ plugins: [budgetOf({ requests: 1, seconds: 60 })] });

        await kernel.handle({ method: "GET", path: "/thing", input: {}, identity: createIdentity("u1") });

        const flooded = await kernel.handle({ method: "GET", path: "/thing", input: {}, identity: createIdentity("u1") });
        const other = await kernel.handle({ method: "GET", path: "/thing", input: {}, identity: createIdentity("u2") });

        expect(flooded.status).toBe(429);
        expect(other.status).toBe(200);
    });

    test("never reaches the handler once the budget is spent", async () =>
    {
        let ran = 0;

        const kernel = await startKernel({
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
        const kernel = await startKernel({ plugins: [budgetOf()] });

        const answers = [];

        for (let at = 0; at < 50; at += 1)
        {
            answers.push(await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" }));
        }

        expect(answers.every((answer) => answer.status === 200)).toBe(true);
    });
});

describe("a budget counting only what it guards against", () =>
{
    function guarding(): Plugin
    {
        return definePlugin("gate", {
            version: "1.0.0",
            describe: "Takes a secret.",
            routes: [{
                method: "POST",
                path: "/gate",
                describe: "Opens.",
                public: true,
                limit: { requests: 3, seconds: 300, countSuccess: false },
                input: z.object({ secret: z.string() }),
                output: z.object({ ok: z.boolean() }),
                handle: (given: { secret: string }) =>
                {
                    if (given.secret !== "right")
                    {
                        throw new Refusal(401, "NO", "Wrong.");
                    }

                    return { ok: true };
                },
            }],
        } as Definition);
    }

    async function press(kernel: Awaited<ReturnType<typeof startKernel>>, secret: string, times: number): Promise<number[]>
    {
        const got: number[] = [];

        for (let turn = 0; turn < times; turn += 1)
        {
            const answer = await kernel.handle({ method: "POST", path: "/gate", input: { secret }, from: "1.2.3.4" });

            got.push(answer.status);
        }

        return got;
    }

    test("lets a caller succeed past the window, and still stops one guessing", async () =>
    {
        const kernel = await startKernel({ plugins: [guarding()] });

        // Six devices signing in is not six attacks.
        expect(await press(kernel, "right", 6)).toEqual([201, 201, 201, 201, 201, 201]);

        // The same caller guessing still runs out.
        expect(await press(kernel, "wrong", 5)).toEqual([401, 401, 401, 429, 429]);
    });

    test("counts every call when the route does not say otherwise", async () =>
    {
        const kernel = await startKernel({ plugins: [budgetOf({ requests: 3, seconds: 60 })] });

        const got: number[] = [];

        for (let turn = 0; turn < 5; turn += 1)
        {
            got.push((await kernel.handle({ method: "GET", path: "/thing", input: {}, from: "1.2.3.4" })).status);
        }

        expect(got).toEqual([200, 200, 200, 429, 429]);
    });

    test("keeps the spend when a handler answers a refusal rather than raising one", async () =>
    {
        const kernel = await startKernel({
            plugins: [definePlugin("claims", {
                version: "1.0.0",
                describe: "Answers a conflict without throwing.",
                routes: [{
                    method: "POST",
                    path: "/claims",
                    describe: "Claims.",
                    public: true,
                    limit: { requests: 3, seconds: 300, countSuccess: false },
                    input: z.object({}),
                    output: z.object({ ok: z.boolean() }),
                    handle: () => new Reply(409, { ok: false }),
                }],
            } as Definition)],
        });

        const got: number[] = [];

        for (let turn = 0; turn < 5; turn += 1)
        {
            got.push((await kernel.handle({ method: "POST", path: "/claims", input: {}, from: "9.9.9.9" })).status);
        }

        expect(got).toEqual([409, 409, 409, 429, 429]);
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
        const kernel = await startKernel({ plugins: [budgetOf({ requests: 0, seconds: 60 })] }).catch((cause: unknown) => cause as Error);

        expect((kernel as Error).message).toMatch(/refuses everything/);
    });

    test("refuses a window with no length", async () =>
    {
        const kernel = await startKernel({ plugins: [budgetOf({ requests: 5, seconds: 0 })] }).catch((cause: unknown) => cause as Error);

        expect((kernel as Error).message).toMatch(/never resets/);
    });
});
