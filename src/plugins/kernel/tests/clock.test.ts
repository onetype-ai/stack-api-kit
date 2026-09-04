import { describe, expect, test } from "vitest";

import { createKernel, definePlugin } from "../api";

function asking(now?: () => number)
{
    return createKernel({
        plugins: [definePlugin("thing", {
            version: "1.0.0",
            describe: "Reads the time.",
            services: (ctx) => ({ when: () => ctx.now() }),
        })],
        ...(now !== undefined && { now }),
    });
}

describe("the time a plugin reads", () =>
{
    test("is the project's, so a test can pin it", async () =>
    {
        const kernel = asking(() => 1_700_000_000_000);

        await kernel.start();

        expect((kernel.context("thing").services as { when: () => number }).when()).toBe(1_700_000_000_000);

        await kernel.stop();
    });

    test("is the real one when the project named none", async () =>
    {
        const kernel = asking();

        await kernel.start();

        const read = (kernel.context("thing").services as { when: () => number }).when();

        expect(read).toBeGreaterThan(1_700_000_000_000);
        expect(Math.abs(read - Date.now())).toBeLessThan(1000);

        await kernel.stop();
    });
});
