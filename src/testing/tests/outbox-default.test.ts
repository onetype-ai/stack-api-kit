import { expect, test } from "vitest";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

const quiet = definePlugin("quiet", { version: "1.0.0", describe: "Declares nothing." });

test("a test kernel asked for no outbox says once per process that 9.0 turns it on, and how to choose", async () =>
{
    const warnings: { code?: string; message: string }[] = [];
    const hear = (warning: Error & { code?: string }): void =>
    {
        warnings.push({ ...(warning.code !== undefined && { code: warning.code }), message: warning.message });
    };

    process.on("warning", hear);

    const first = await startTestKernel({ plugins: [quiet] });
    const second = await startTestKernel({ plugins: [quiet] });
    const chosen = await startTestKernel({ plugins: [quiet], outbox: false });

    await Promise.all([first.stop(), second.stop(), chosen.stop()]);
    await new Promise((resolve) => setImmediate(resolve));
    process.off("warning", hear);

    const ours = warnings.filter((warning) => warning.code === "STACK_API_KIT_TEST_OUTBOX");

    expect(ours).toHaveLength(1);
    expect(ours[0]?.message).toContain("Pass outbox: true");
});
