import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../../kernel/api";
import { serve } from "../api";

function serving()
{
    return createKernel({
        plugins: [definePlugin("thing", {
            version: "1.0.0",
            describe: "The thing plugin.",
            routes: [{
                method: "GET",
                path: "/thing",
                describe: "Answers.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                handle: () => ({ ok: true }),
            }],
        })],
    });
}

describe("what a deployment asks", () =>
{
    test("live answers before the kernel has started", async () =>
    {
        const app = serve({ kernel: serving() });

        const answer = await app.request("/live");

        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ live: true });
    });

    test("ready refuses until the kernel has started", async () =>
    {
        const kernel = serving();
        const app = serve({ kernel });

        const before = await app.request("/ready");

        expect(before.status).toBe(503);
        expect(await before.json()).toEqual({ ready: false });

        await kernel.start();

        const after = await app.request("/ready");

        expect(after.status).toBe(200);
        expect(await after.json()).toEqual({ ready: true });
    });

    test("ready refuses again once it has stopped", async () =>
    {
        const kernel = serving();
        const app = serve({ kernel });

        await kernel.start();
        await kernel.stop();

        const answer = await app.request("/ready");

        expect(answer.status).toBe(503);
    });
});
