import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, KernelFault } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { Context } from "../../index";

const busy = definePlugin("busy", {
    version: "1.0.0",
    describe: "Leaves work in flight: an event for a listener and a job for later.",
    emits: { "busy.done": { describe: "Work was done.", schema: z.object({ id: z.string() }) } },
    listens: {},
    commands: { "busy.later": { describe: "Later work.", schema: z.object({ id: z.string() }), run: async () => undefined } },
    routes: [defineRoute<Context>()({
        method: "POST", path: "/busy", describe: "Does work.", public: true, input: z.object({ id: z.string() }), output: z.object({}),
        handle: async (input, ctx) =>
        {
            await ctx.tx(async (inside) =>
            {
                inside.events.emit("busy.done", input);
                inside.commands.later("busy.later", input, 0);
            });

            return {};
        },
    })],
});

const hearing = definePlugin("hearing", {
    version: "1.0.0",
    describe: "Hears work slowly.",
    dependsOn: ["busy"],
    listens: { "busy.done": { describe: "Hears it.", handle: async () => new Promise((resolve) => setTimeout(resolve, 50)) } },
});

const refusing = definePlugin("refusing", {
    version: "1.0.0",
    describe: "Refuses to start.",
    setup: () =>
    {
        throw new KernelFault("INVALID_CONFIG", "refusing: roles nobody holds: god");
    },
});

test("a kernel stopped with work in flight leaves the database as it found it, so the next one's own error comes through", async () =>
{
    const first = await startTestKernel({ plugins: [busy, hearing], schedule: true, outbox: true });

    await first.kernel.handle({ method: "POST", path: "/busy", input: { id: "a" } });
    await first.stop();

    await expect(startTestKernel({ plugins: [refusing] })).rejects.toThrow("roles nobody holds: god");
});
