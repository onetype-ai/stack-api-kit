import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { TestKernel } from "../startTestKernel";

const operations = definePlugin("operations", {
    version: "1.0.0",
    describe: "Shows operators how the work is doing.",
    watchesWork: true,
});

const bystander = definePlugin("bystander", {
    version: "1.0.0",
    describe: "Has no business reading the work.",
});

const reminders = definePlugin("reminders", {
    version: "1.0.0",
    describe: "Sends a reminder later, and fails at it.",
    commands: {
        "reminders.send": {
            describe: "Sends one reminder.",
            schema: z.object({ secret: z.string() }),
            run: () =>
            {
                throw new Error("the mail server is down");
            },
        },
    },
});

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

describe("a plugin watching the work", () =>
{
    test("reads how many jobs are due and waiting, and how the outbox is doing", async () =>
    {
        api = await startTestKernel({ plugins: [operations, reminders], schedule: true, outbox: true });

        const scheduling = api.kernel.context("reminders");

        scheduling.commands.later("reminders.send", { secret: "s1" }, 0);
        scheduling.commands.later("reminders.send", { secret: "s2" }, 3600);

        const health = await api.kernel.context("operations").work.health();

        expect(health).toEqual({ jobs: { due: 1, later: 1, running: 0, abandoned: 0, failed: 0 }, outbox: { waiting: 0, retrying: 0, dead: 0 } });
    });

    test("sees a job given up by name and error kind, never its input", async () =>
    {
        let now = Date.now();

        api = await startTestKernel({ plugins: [operations, reminders], schedule: true, outbox: true, now: () => now });

        api.kernel.context("reminders").commands.later("reminders.send", { secret: "never-shown" }, 0);

        for (let round = 0; round < 8; round += 1)
        {
            await api.due();
            now += 120_000;
        }

        const failed = api.kernel.context("operations").work.failedJobs();

        expect(failed).toEqual([expect.objectContaining({ plugin: "reminders", command: "reminders.send", attempts: 8, error: "Error" })]);
        expect(JSON.stringify(failed)).not.toContain("never-shown");
    });

    test("is the only one that may: any other plugin reading it is refused by name", async () =>
    {
        api = await startTestKernel({ plugins: [operations, bystander] });

        const ctx = api.kernel.context("bystander");

        expect(() => ctx.work).toThrow("\"bystander\" read ctx.work, which only a plugin declaring watchesWork: true may");
    });
});
