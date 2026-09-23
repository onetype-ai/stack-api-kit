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

test("a suite that turned the outbox off by default gets none", async () =>
{
    configureTestKernels({ defaults: { outbox: false } });
    const api = await startTestKernel({ plugins: [announcing] });

    expect(() => api.kernel.context("announcing").events.emit("announcing.made", {})).not.toThrow();

    await api.stop();
});
