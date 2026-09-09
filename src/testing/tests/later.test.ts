import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { startTestKernel } from "../startTestKernel";

test("a test drives its own clock and asks for what is due", async () =>
{
    const ran: string[] = [];
    let clock = 1_000_000;

    const plugin = definePlugin("holds", {
        version: "1.0.0",
        describe: "Releases a hold later.",
        commands: {
            "holds.release": {
                describe: "Releases one.",
                schema: z.object({ id: z.string() }),
                run: (input) => { ran.push((input as { id: string }).id); },
            },
        },
    });

    const api = await startTestKernel({ plugins: [plugin], schedule: true, now: () => clock });

    api.kernel.context("holds").commands.later("holds.release", { id: "one" }, 600);

    await api.due();

    expect(ran).toEqual([]);

    clock += 601_000;

    await api.due();

    expect(ran).toEqual(["one"]);

    await api.stop();
});

test("drain runs a chain through, where due runs one link of it", async () =>
{
    const ran: string[] = [];

    const plugin = definePlugin("chain", {
        version: "1.0.0",
        describe: "Work that asks for the next of itself.",
        commands: {
            "chain.one": {
                describe: "First.",
                schema: z.object({}),
                run: (_input, ctx) => { ran.push("one"); ctx.commands.later("chain.two", {}, 0); },
            },
            "chain.two": {
                describe: "Second.",
                schema: z.object({}),
                run: (_input, ctx) => { ran.push("two"); ctx.commands.later("chain.three", {}, 0); },
            },
            "chain.three": {
                describe: "Third.",
                schema: z.object({}),
                run: () => { ran.push("three"); },
            },
        },
    });

    const api = await startTestKernel({ plugins: [plugin], schedule: true });

    await api.kernel.run("chain.one", {});
    await api.drain();

    await api.stop();

    expect(ran).toEqual(["one", "two", "three"]);
});

test("and stops at the bound, so work asking for itself cannot spin", async () =>
{
    let turns = 0;

    const plugin = definePlugin("sweeping", {
        version: "1.0.0",
        describe: "Work that asks for itself as it ends.",
        commands: {
            "sweeping.sweep": {
                describe: "Sweeps, then asks again.",
                schema: z.object({}),
                run: (_input, ctx) => { turns += 1; ctx.commands.later("sweeping.sweep", {}, 0); },
            },
        },
    });

    const api = await startTestKernel({ plugins: [plugin], schedule: true });

    await api.kernel.run("sweeping.sweep", {});
    await api.drain(3);

    await api.stop();

    expect(turns).toBe(4);
});

test("asking for later work without a schedule names the plugin that asked, not just the option", async () =>
{
    const sweeper = definePlugin("sweeper", {
        version: "1.0.0",
        describe: "Asks for later work while it starts.",
        commands: { "sweeper.sweep": { describe: "Clears old rows.", schema: z.object({}), run: () => undefined } },
        setup: (ctx) => { ctx.commands.later("sweeper.sweep", {}, 60); },
    });

    // A neighbour that wants nothing to do with schedules, and whose test this
    // would be: a boot is shared, so it stops for them too.
    const bystander = definePlugin("bystander", { version: "1.0.0", describe: "Keeps to itself." });

    await expect(startTestKernel({ plugins: [bystander, sweeper] }))
        .rejects.toThrow(/"sweeper" used ctx\.commands\.later/);
});
