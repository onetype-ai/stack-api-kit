import { expect, test } from "vitest";

import { createKernel, definePlugin } from "../api";

test("a listener booted without its emitter is told to bring it", async () =>
{
    const kernel = createKernel({
        plugins: [definePlugin("ledger", {
            version: "1.0.0",
            describe: "Hears about orders.",
            listens: {
                "orders.placed": { describe: "Records it.", handle: () => undefined },
            },
        })],
    });

    const failed = await kernel.start().catch((cause: unknown) => cause as Error);

    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch(/"orders" would declare it/);
    expect((failed as Error).message).toMatch(/pass it too/);
});
