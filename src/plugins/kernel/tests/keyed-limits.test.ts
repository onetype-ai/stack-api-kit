import { describe, expect, test } from "vitest";
import { z } from "zod";

import { limiter } from "../../guard/api";
import { createKernel, definePlugin, Refusal } from "../api";

import type { Definition } from "../api";

function signingIn(key?: unknown, refusing = false)
{
    return definePlugin("accounts", {
        version: "1.0.0",
        describe: "Signs people in.",
        routes: [{
            method: "POST",
            path: "/sign-in",
            describe: "Signs one in.",
            public: true,
            input: z.object({ email: z.string() }),
            output: z.object({ ok: z.boolean() }),
            limit: { requests: 2, seconds: 60, ...(key !== undefined && { key }) },
            handle: () =>
            {
                if (refusing)
                {
                    throw new Refusal(429, "SLOW_DOWN", "Wait a moment.", undefined, { retryAfter: 7.2 });
                }

                return { ok: true };
            },
        }],
    } as unknown as Definition);
}

async function statuses(key: unknown, asks: readonly { email: string; from: string }[]): Promise<number[]>
{
    const kernel = createKernel({ plugins: [signingIn(key)], rateLimiter: limiter() });

    await kernel.start();

    const answers: number[] = [];

    for (const ask of asks)
    {
        answers.push((await kernel.handle({ method: "POST", path: "/sign-in", input: { email: ask.email }, from: ask.from })).status);
    }

    return answers;
}

describe("a limit counted by what the route names", () =>
{
    test("by a function of the input, counts one email from every address together", async () =>
    {
        const asks = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((from) => ({ email: "ana@example.test", from }));

        expect(await statuses((input: { email: string }) => input.email, asks)).toEqual([201, 201, 429]);
    });

    test("by default, counts each address apart", async () =>
    {
        const asks = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((from) => ({ email: "ana@example.test", from }));

        expect(await statuses(undefined, asks)).toEqual([201, 201, 201]);
    });

    test("is refused at startup counting by anything else", async () =>
    {
        const kernel = createKernel({ plugins: [signingIn("email")], rateLimiter: limiter() });

        await expect(kernel.start()).rejects.toThrow("counts its limit by \"email\"");
    });
});

describe("a refusal asking the caller to wait", () =>
{
    test("says how long in retry-after, rounded up to a whole second", async () =>
    {
        const kernel = createKernel({ plugins: [signingIn(undefined, true)], rateLimiter: limiter() });

        await kernel.start();

        const answer = await kernel.handle({ method: "POST", path: "/sign-in", input: { email: "a@b.test" }, from: "1.1.1.1" });

        expect(answer).toMatchObject({ status: 429, body: { code: "SLOW_DOWN" }, headers: { "retry-after": "8" } });
    });
});
