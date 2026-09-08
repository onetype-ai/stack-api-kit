import { describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute } from "../../kernel/api";
import { start } from "../api";

import type { Context } from "../../kernel/api";

const route = defineRoute<Context>();

/** One route that pushes down a channel the plugin declares. */
const talker = definePlugin("talker", {
    version: "1.0.0",
    describe: "Says a thing to whoever is listening.",
    channels: {
        "talker.said": {
            describe: "Said something.",
            schema: z.object({ text: z.string() }),
            reach: "everyone",
        },
    },
    routes: [
        route({
            method: "GET", path: "/say", describe: "Says.", public: true,
            input: z.object({}), output: z.object({ ok: z.boolean() }),
            handle: (_input, ctx) =>
            {
                ctx.push("talker.said", { text: "hello" });

                return { ok: true };
            },
        }),
    ],
});

describe("whether an application holds sockets without asking", () =>
{
    test("pushes with nothing declared", async () =>
    {
        const api = await start({ plugins: [talker] });

        expect((await api.fetch(new Request("http://localhost/say"))).status).toBe(200);
    });

    test("refuses the push when sockets were turned off", async () =>
    {
        const api = await start({ plugins: [talker], sockets: false });

        expect((await api.fetch(new Request("http://localhost/say"))).status).toBe(500);
    });
});
