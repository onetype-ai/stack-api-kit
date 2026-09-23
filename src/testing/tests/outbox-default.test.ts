import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

const announcing = definePlugin("announcing", {
    version: "1.0.0",
    describe: "Emits outside any transaction.",
    emits: { "announcing.made": { describe: "Something was made.", schema: z.object({}) } },
});

test("a test kernel keeps events in an outbox unless told not to, as a deployment does, and warns of nothing", async () =>
{
    const warnings: string[] = [];
    const hear = (warning: Error & { code?: string }): void =>
    {
        warnings.push(warning.code ?? warning.message);
    };

    process.on("warning", hear);

    const kept = await startTestKernel({ plugins: [announcing] });
    const refused = await startTestKernel({ plugins: [announcing], outbox: false });

    expect(() => kept.kernel.context("announcing").events.emit("announcing.made", {})).toThrow(/outside a transaction while an outbox is configured/);
    expect(() => refused.kernel.context("announcing").events.emit("announcing.made", {})).not.toThrow();

    await Promise.all([kept.stop(), refused.stop()]);
    await new Promise((resolve) => setImmediate(resolve));
    process.off("warning", hear);

    expect(warnings.filter((warning) => warning === "STACK_API_KIT_TEST_OUTBOX")).toEqual([]);
});
