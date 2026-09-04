import { describe, expect, test } from "vitest";

import { createKernel, definePlugin } from "../api";

describe("what a plugin owns", () =>
{
    test("is the same thing every request sees, though services are not", async () =>
    {
        let built = 0;
        let opened = 0;

        const kernel = createKernel({
            plugins: [definePlugin("cache", {
                version: "1.0.0",
                describe: "Holds one connection.",

                setup: (ctx) =>
                {
                    opened += 1;

                    ctx.owns({ id: `connection-${String(opened)}` });
                },

                services: (ctx) =>
                {
                    built += 1;

                    return { reach: () => ctx.owned<{ id: string }>()?.id ?? "NONE" };
                },
            })],
        });

        await kernel.start();

        const seen = [1, 2, 3].map(() =>
            (kernel.context("cache").services as { reach: () => string }).reach());

        await kernel.stop();

        expect(opened).toBe(1);
        expect(built).toBe(3);
        expect(seen).toEqual(["connection-1", "connection-1", "connection-1"]);
    });

    test("is reachable in teardown, so what was opened can be closed", async () =>
    {
        const closed: string[] = [];

        const kernel = createKernel({
            plugins: [definePlugin("cache", {
                version: "1.0.0",
                describe: "Closes what it opened.",
                setup: (ctx) => void ctx.owns({ quit: () => void closed.push("closed") }),
                teardown: (ctx) => ctx.owned<{ quit: () => void }>()?.quit(),
            })],
        });

        await kernel.start();
        await kernel.stop();

        expect(closed).toEqual(["closed"]);
    });

    test("is not another plugin's", async () =>
    {
        const kernel = createKernel({
            plugins: [
                definePlugin("a", { version: "1.0.0", describe: "Owns one.", setup: (ctx) => void ctx.owns("mine") }),
                definePlugin("b", { version: "1.0.0", describe: "Owns none." }),
            ],
        });

        await kernel.start();

        expect(kernel.context("a").owned<string>()).toBe("mine");
        expect(kernel.context("b").owned<string>()).toBeUndefined();

        await kernel.stop();
    });
});
