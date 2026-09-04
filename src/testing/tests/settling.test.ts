import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { booting } from "../booting";

test("what a listener wrote is there once the test waits for it", async () =>
{
    const written: string[] = [];

    const api = await booting({
        plugins: [
            definePlugin("source", {
                version: "1.0.0",
                describe: "Emits.",
                emits: { "source.happened": { describe: "Happened.", schema: z.object({ id: z.string() }) } },
            }),
            definePlugin("sink", {
                version: "1.0.0",
                describe: "Writes when it hears.",
                listens: {
                    "source.happened": {
                        describe: "Records.",
                        handle: async (payload, ctx) =>
                        {
                            await ctx.write(async () =>
                            {
                                written.push((payload as { id: string }).id);
                            });
                        },
                    },
                },
            }),
        ],
    });

    const seen: number[] = [];

    for (const id of ["a", "b", "c"])
    {
        api.kernel.context("source").events.emit("source.happened", { id });

        seen.push(written.length);
    }

    await api.settled();

    await api.stop();

    expect(written).toEqual(["a", "b", "c"]);
});

test("a chain of two listeners settles too", async () =>
{
    const reached: string[] = [];

    const api = await booting({
        plugins: [
            definePlugin("first", {
                version: "1.0.0",
                describe: "Starts the chain.",
                emits: { "first.done": { describe: "Done.", schema: z.object({ id: z.string() }) } },
            }),
            definePlugin("second", {
                version: "1.0.0",
                describe: "Hears the first and announces its own.",
                emits: { "second.done": { describe: "Done.", schema: z.object({ id: z.string() }) } },
                listens: {
                    "first.done": {
                        describe: "Passes it on.",
                        handle: (payload, ctx) =>
                        {
                            reached.push("second");

                            ctx.events.emit("second.done", payload as { id: string });
                        },
                    },
                },
            }),
            definePlugin("third", {
                version: "1.0.0",
                describe: "Hears the second.",
                listens: {
                    "second.done": {
                        describe: "Records the end of the chain.",
                        handle: () => { reached.push("third"); },
                    },
                },
            }),
        ],
    });

    api.kernel.context("first").events.emit("first.done", { id: "one" });

    await api.settled();

    await api.stop();

    expect(reached).toEqual(["second", "third"]);
});
