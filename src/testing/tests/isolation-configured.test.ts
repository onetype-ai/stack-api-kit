import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { configureTestKernels, startTestKernel } from "../startTestKernel";

// With isolation-plain.test.ts: two suites in one worker, each seeing only what it configured itself.
const announcing = definePlugin("announcing", {
    version: "1.0.0",
    describe: "Emits outside any transaction.",
    emits: { "announcing.made": { describe: "Something was made.", schema: z.object({}) } },
});

test("a suite that asked for an outbox by default gets one", async () =>
{
    configureTestKernels({ defaults: { outbox: true } });
    const api = await startTestKernel({ plugins: [announcing] });

    expect(() => api.kernel.context("announcing").events.emit("announcing.made", {})).toThrow(/outside a transaction/);

    await api.stop();
});
