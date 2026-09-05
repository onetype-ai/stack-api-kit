import { expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

import type { Definition, Plugin } from "../api";

function participant(name: string, found: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, { version: "1.0.0", describe: `The ${name} plugin.`, ...found });
}

test("a participant that never answers is a refusal, not a request held open", async () =>
{
    const kernel = createKernel({
        patience: 50,
        plugins: [
            participant("owner", { hooks: { "owner.check": { describe: "A check.", schema: z.object({}) } } }),
            participant("silent", {
                participates: {
                    "owner.check": {
                        describe: "Never answers at all.",
                        handle: () => new Promise<undefined>(() => {}),
                    },
                },
            }),
        ],
    });

    await kernel.start();

    const verdict = await Promise.race([
        kernel.context("owner").hooks.run("owner.check", {}),
        new Promise((keep) => setTimeout(() => keep("STILL HANGING"), 3000)),
    ]);

    expect(verdict).toBe('"silent" did not answer in 50ms.');
});

test("a participant that answers in time is still heard", async () =>
{
    const kernel = createKernel({
        patience: 500,
        plugins: [
            participant("owner", { hooks: { "owner.check": { describe: "A check.", schema: z.object({}) } } }),
            participant("slow", {
                participates: {
                    "owner.check": {
                        describe: "Answers, but not at once.",
                        handle: async () =>
                        {
                            await new Promise((keep) => setTimeout(keep, 20));

                            return "no, because it said so";
                        },
                    },
                },
            }),
        ],
    });

    await kernel.start();

    await expect(kernel.context("owner").hooks.run("owner.check", {})).resolves.toBe("no, because it said so");
});
