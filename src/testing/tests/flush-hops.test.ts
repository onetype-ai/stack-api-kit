import { expect, test } from "vitest";
import { z } from "zod";

import { defineListener, definePlugin, defineRoute } from "../../index";
import { startTestKernel } from "../startTestKernel";

const heard: string[] = [];
const tick = (): Promise<void> => new Promise((done) =>
{
    setTimeout(done, 0);
});

const speaker = definePlugin("speaker", {
    version: "1.0.0",
    describe: "Emits one event from a route.",
    emits: { "speaker.said": { describe: "Something was said.", schema: z.object({ word: z.string() }) } },
    routes: [defineRoute()({
        method: "POST", path: "/say", describe: "Says a word.", public: true, limit: { requests: 100, seconds: 60 },
        input: z.object({ word: z.string() }), output: z.object({}),
        handle: async (input, ctx) =>
        {
            await ctx.tx(async (inside) =>
            {
                inside.events.emit("speaker.said", input);
            });

            return {};
        },
    })],
});

const listener = definePlugin("listener", {
    version: "1.0.0",
    describe: "Hears the word after many async hops, as a listener doing several awaited reads does.",
    dependsOn: ["speaker"],
    listens: {
        "speaker.said": defineListener()(z.object({ word: z.string() }), {
            describe: "Records the word.",
            handle: async (payload) =>
            {
                for (let hop = 0; hop < 60; hop += 1)
                {
                    await tick();
                }

                heard.push(payload.word);
            },
        }),
    },
});

test.each([false, true])("flush waits for a listener far past a few ticks (outbox %s)", async (outbox) =>
{
    heard.length = 0;
    const api = await startTestKernel({ plugins: [speaker, listener], outbox });

    await api.kernel.handle({ method: "POST", path: "/say", input: { word: "hello" } });
    await api.flush();

    expect(heard).toEqual(["hello"]);
    await api.stop();
});
