import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { startTestKernel } from "../startTestKernel";

// With isolation-configured.test.ts: a suite that configured nothing sees no defaults another suite set.
const announcing = definePlugin("announcing", {
    version: "1.0.0",
    describe: "Emits outside any transaction.",
    emits: { "announcing.made": { describe: "Something was made.", schema: z.object({}) } },
});

test("a suite that configured nothing gets a kernel without an outbox, whatever ran before it", async () =>
{
    const api = await startTestKernel({ plugins: [announcing] });

    expect(() => api.kernel.context("announcing").events.emit("announcing.made", {})).not.toThrow();

    await api.stop();
});
