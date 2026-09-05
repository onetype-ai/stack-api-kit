import { expect, test } from "vitest";
import { z } from "zod";

import { database } from "../../database/api";
import { createKernel, definePlugin } from "../api";

import type { Definition, Plugin } from "../api";

function participant(name: string, found: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, { version: "1.0.0", describe: `The ${name} plugin.`, ...found });
}

test("a request in flight is answered before the plugins are torn down", async () =>
{
    const order: string[] = [];
    const store = database({ file: ":memory:", tables: { a: {} } });

    const kernel = createKernel({
        plugins: [participant("a", {
            teardown: () => { order.push("teardown"); },
            routes: [{
                method: "POST",
                path: "/slow",
                describe: "Takes its time.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                handle: async (_input, ctx) =>
                {
                    order.push("handler-start");

                    return ctx.tx(async () =>
                    {
                        await new Promise((keep) => setTimeout(keep, 80));

                        order.push("work-done");

                        return { ok: true };
                    });
                },
            }],
        })],
        db: store,
    });

    await kernel.start();

    const inFlight = kernel.handle({ method: "POST", path: "/slow", input: {} });

    await new Promise((keep) => setTimeout(keep, 20));

    order.push("stop-called");
    await kernel.stop();
    order.push("stop-returned");
    store.close();

    const answer = await inFlight;

    expect(answer.status).toBe(201);
    expect(order).toEqual(["handler-start", "stop-called", "work-done", "teardown", "stop-returned"]);
});

test("a kernel that has stopped refuses rather than answering", async () =>
{
    const kernel = createKernel({
        plugins: [participant("a", {
            routes: [{
                method: "GET",
                path: "/ping",
                describe: "Answers.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                handle: () => ({ ok: true }),
            }],
        })],
    });

    await kernel.start();
    await kernel.stop();

    const answer = await kernel.handle({ method: "GET", path: "/ping", input: {} });

    expect(answer.status).toBe(503);
});
