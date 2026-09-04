import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, defineRoute } from "../api";

import type { Context } from "../api";

type Made = Context<unknown, unknown>;

/**
 * The three faults a survey found in 98% of generated applications: a
 * credential reachable from the client, CORS that allows anyone, and a route
 * callable without authorisation.
 *
 * None of them is advice here. Each is refused, and each of these fails when
 * the refusal is removed.
 */
describe("what a generated application cannot get wrong here", () =>
{
    test("a route reading a credential header refuses to start", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("leaky", {
                version: "1.0.0",
                describe: "Reads the token itself.",
                routes: [defineRoute<Made>()({
                    method: "GET",
                    path: "/leak",
                    describe: "Holds what identifies the caller.",
                    public: true,
                    reads: ["authorization"],
                    input: z.object({}),
                    output: z.object({ ok: z.boolean() }),
                    handle: () => ({ ok: true }),
                })],
            })],
        });

        await expect(kernel.start()).rejects.toThrow(/credential/);
    });

    test("a route is closed until it says otherwise, so a stranger is 401", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("guarded", {
                version: "1.0.0",
                describe: "One route, permission required.",
                permissions: { "guarded.read": { describe: "See it." } },
                routes: [defineRoute<Made>()({
                    method: "GET",
                    path: "/private",
                    describe: "Needs somebody.",
                    requires: ["guarded.read"],
                    input: z.object({}),
                    output: z.object({ ok: z.boolean() }),
                    handle: () => ({ ok: true }),
                })],
            })],
        });

        await kernel.start();

        expect((await kernel.handle({ method: "GET", path: "/private", input: {} })).status).toBe(401);

        await kernel.stop();
    });

    test("and a permission nothing declares refuses to start, so a typo is not an opening", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("typo", {
                version: "1.0.0",
                describe: "Asks for what nobody defines.",
                permissions: { "typo.read": { describe: "See it." } },
                routes: [defineRoute<Made>()({
                    method: "GET",
                    path: "/x",
                    describe: "x",
                    requires: ["guarded.raed"],
                    input: z.object({}),
                    output: z.object({ ok: z.boolean() }),
                    handle: () => ({ ok: true }),
                })],
            })],
        });

        await expect(kernel.start()).rejects.toThrow();
    });
});
