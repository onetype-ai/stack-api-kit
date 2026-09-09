import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, defineRoute } from "../api";

import type { Context } from "../api";

type TestContext = Context<unknown, unknown>;

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
                routes: [defineRoute<TestContext>()({
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

    /** One route reading one header, with or without the bytes it needs. */
    function signing(header: string, keepsRaw: boolean)
    {
        return createKernel({
            plugins: [definePlugin("billing", {
                version: "1.0.0",
                describe: "Takes a signed webhook.",
                routes: [defineRoute<TestContext>()({
                    method: "POST",
                    path: "/billing/webhook",
                    describe: "Takes a signed delivery.",
                    public: true,
                    reads: [header],
                    ...keepsRaw && { keepsRaw: true },
                    input: z.object({ id: z.string() }),
                    output: z.object({ ok: z.boolean() }),
                    handle: () => ({ ok: true }),
                })],
            })],
        });
    }

    test("a route claiming a signature check without the bytes refuses to start", async () =>
    {
        // Refused rather than warned: no amount of care in the handler makes
        // this work, because the bytes it would check are already gone.
        await expect(signing("stripe-signature", false).start())
            .rejects.toThrow(/reads "stripe-signature" and does not declare keepsRaw/);
    });

    test("the same route starts once it declares keepsRaw", async () =>
    {
        await expect(signing("stripe-signature", true).start()).resolves.toBeUndefined();
    });

    test("knows a signature header by its shape, not by whose webhook it is", async () =>
    {
        // A list of names would be a list of partners the kit has heard of.
        for (const header of ["x-hub-signature-256", "svix-signature", "x-shopify-hmac-sha256", "paypal-transmission-sig"])
        {
            await expect(signing(header, false).start()).rejects.toThrow(/does not declare keepsRaw/);
        }
    });

    test("says nothing about an ordinary header", async () =>
    {
        // "sig" as a whole word, not as letters inside another one.
        for (const header of ["origin", "accept-language", "x-request-id", "x-sigma"])
        {
            await expect(signing(header, false).start()).resolves.toBeUndefined();
        }
    });

    test("a route is closed until it says otherwise, so a stranger is 401", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("guarded", {
                version: "1.0.0",
                describe: "One route, permission required.",
                permissions: { "guarded.read": { describe: "See it." } },
                routes: [defineRoute<TestContext>()({
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
                routes: [defineRoute<TestContext>()({
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
