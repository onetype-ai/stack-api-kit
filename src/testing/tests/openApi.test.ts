import { describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute } from "../../index";
import { openApi } from "../openApi";
import { testClock } from "../testClock";

import type { Context, Identity } from "../../index";

type Notices = { send: (to: string) => string };

const notices = definePlugin("notices", { version: "1.0.0", describe: "Sends notices for real.", services: (): Notices => ({ send: () => "sent for real" }) });
const quietNotices = definePlugin("notices", { version: "1.0.0", describe: "Sends nothing.", fake: true, services: (): Notices => ({ send: (to) => `kept for ${to}` }) });

const items = definePlugin("items", {
    version: "1.0.0",
    describe: "Answers who asked, when, and through which notices.",
    dependsOn: ["notices"],
    permissions: { "items.read": { describe: "Reads items." } },
    routes: [defineRoute<Context>()({
        method: "GET", path: "/items/who", describe: "Who asked.", requires: ["items.read"],
        input: z.object({}), output: z.object({ id: z.string(), at: z.number(), notice: z.string() }),
        handle: (_input, ctx) => ({ id: ctx.identity?.id ?? "", at: ctx.now(), notice: ctx.use<Notices>("notices").send("items") }),
    })],
});

const reader: Identity = { id: "reader-1", permissions: ["items.read"], claims: {} };

describe("openApi", () =>
{
    test("calls a route as the identity given, through the stand-in, on the clock the test moves", async () =>
    {
        const { api, clock, call } = await openApi({ plugins: [items], stands: { notices: quietNotices }, clock: testClock(1_000) });
        clock.advance(500);

        const answer = await call(reader, "GET", "/items/who");

        expect(answer).toMatchObject({ status: 200, body: { id: "reader-1", at: 1_500, notice: "kept for items" } });
        await api.stop();
    });

    test("refuses a caller lacking the permission, and one signed out", async () =>
    {
        const { api, call } = await openApi({ plugins: [items, notices] });

        const lacking = await call({ id: "other-1", permissions: [], claims: {} }, "GET", "/items/who");
        const nobody = await call(undefined, "GET", "/items/who");

        expect(lacking.status).toBe(403);
        expect(nobody.status).toBe(401);
        await api.stop();
    });

    test("runs the seed once the kernel runs, and a seed that throws stops the kernel it booted", async () =>
    {
        const seen: boolean[] = [];

        const { api } = await openApi({ plugins: [items, notices], seed: (booted) =>
        {
            seen.push(booted.kernel.started());
        } });
        const failing = openApi({ plugins: [items, notices], seed: () =>
        {
            throw new Error("seed broke");
        } });

        expect(seen).toEqual([true]);
        await expect(failing).rejects.toThrow("seed broke");
        await api.stop();
    });

    test.each([
        ["named for another plugin", { notices: definePlugin("mail", { version: "1.0.0", describe: "Mail." }) }, "carries the name it replaces"],
        ["for what nobody depends on", { notices: quietNotices, mail: definePlugin("mail", { version: "1.0.0", describe: "Mail." }) }, "stands in for nothing"],
    ])("refuses a stand-in %s, naming the fix", async (_what, stands, fix) =>
    {
        await expect(openApi({ plugins: [items], stands })).rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining(fix) });
    });

    test("refuses a plugin passed both for real and as a stand-in", async () =>
    {
        await expect(openApi({ plugins: [items, notices], stands: { notices: quietNotices } })).rejects.toThrow("both in plugins and in stands");
    });
});
