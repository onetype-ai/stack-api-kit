import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, start } from "../../index";
import { startTestKernel } from "../startTestKernel";
import { testClock } from "../testClock";

const mailer = definePlugin("mailer", { version: "1.0.0", describe: "Sends nothing, and says it did.", fake: true });

const saved = { ...process.env };

afterEach(() =>
{
    process.env = { ...saved };
});

describe("a stand-in for a real provider", () =>
{
    test("is refused in production, naming it and both ways out", async () =>
    {
        process.env["NODE_ENV"] = "production";
        delete process.env["ALLOW_FAKE"];

        await expect(start({ plugins: [mailer] })).rejects.toThrow("\"mailer\" is a stand-in for a real provider, and this process runs as production. Configure the real provider, or set ALLOW_FAKE=true");
    });

    test("runs in production where the deployment allows it, and anywhere else", async () =>
    {
        process.env["NODE_ENV"] = "production";
        process.env["ALLOW_FAKE"] = "true";

        const allowed = await start({ plugins: [mailer] });

        await allowed.stop();
        process.env["NODE_ENV"] = "development";
        delete process.env["ALLOW_FAKE"];

        const developing = await start({ plugins: [mailer] });

        await developing.stop();
        expect(allowed.kernel.started()).toBe(false);
    });
});

describe("a test clock", () =>
{
    test("moves a scheduled command to its moment without waiting", async () =>
    {
        const ran: string[] = [];
        const clock = testClock(0);
        const reminders = definePlugin("reminders", {
            version: "1.0.0",
            describe: "Reminds later.",
            commands: { "reminders.send": { describe: "Sends one.", schema: z.object({ id: z.string() }), run: (input: { id: string }) => { ran.push(input.id); } } },
        } as unknown as Parameters<typeof definePlugin>[1]);

        const api = await startTestKernel({ plugins: [reminders], schedule: true, now: clock.now });

        api.kernel.context("reminders").commands.later("reminders.send", { id: "r1" }, 3600);
        await api.due();
        const before = [...ran];

        clock.advance(3_600_000);
        await api.due();
        await api.stop();

        expect(before).toEqual([]);
        expect(ran).toEqual(["r1"]);
    });

    test("refuses to run backwards", () =>
    {
        expect(() => testClock(0).advance(-1)).toThrow("advance takes a number of milliseconds of 0 or more");
    });
});

describe("a command scheduled outside a transaction", () =>
{
    test("is still stored, and warned about once, since 9.0 refuses it", async () =>
    {
        const reminders = definePlugin("reminders", {
            version: "1.0.0",
            describe: "Reminds later.",
            commands: { "reminders.send": { describe: "Sends one.", schema: z.object({ id: z.string() }), run: () => undefined } },
        } as unknown as Parameters<typeof definePlugin>[1]);

        const api = await startTestKernel({ plugins: [reminders], schedule: true });
        const ctx = api.kernel.context("reminders");

        ctx.commands.later("reminders.send", { id: "a" }, 60);
        ctx.commands.later("reminders.send", { id: "b" }, 60);
        await ctx.tx(async (inside) =>
        {
            inside.commands.later("reminders.send", { id: "c" }, 60);
        });

        const warnings = api.logLines.filter((line) => line.line.includes("which 9.0 refuses"));

        await api.stop();

        expect(warnings).toHaveLength(1);
    });
});
