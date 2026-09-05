import { expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

test("an event payload failing its own schema is not blamed on the caller", async () =>
{
    const written: string[] = [];

    const kernel = createKernel({
        plugins: [definePlugin("orders", {
            version: "1.0.0",
            describe: "Emits something wrong.",
            emits: { "orders.placed": { describe: "Placed.", schema: z.object({ id: z.uuid() }) } },
            routes: [{
                method: "POST",
                path: "/orders",
                describe: "Places one.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                handle: (_input, ctx) =>
                {
                    // The caller's body was fine. Ours is not.
                    ctx.events.emit("orders.placed", { id: "not-a-uuid" });

                    return { ok: true };
                },
            }],
        })],
        log: (level, _plugin, line) => { if (level === "error") { written.push(line); } },
    });

    await kernel.start();

    const answer = await kernel.handle({ method: "POST", path: "/orders", input: {} });

    // Not a 400: the caller sent nothing wrong.
    expect(answer.status).toBe(500);
    expect(JSON.stringify(answer.body)).not.toContain("request body");

    await kernel.stop();
});
