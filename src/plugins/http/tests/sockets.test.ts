import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../../kernel/api";
import { sockets } from "../api";

import type { Identity, Kernel, Pushed } from "../../kernel/api";

const rooms = {};

/** A plugin with one channel of each reach, and a scope to keep them in. */
const chat = definePlugin("chat", {
    version: "1.0.0",
    describe: "Chat.",
    tables: { chatRooms: rooms },
    scope: { describe: "The shop.", claim: "shopId", tables: { chatRooms: "shopId" } },
    permissions: { "chat.read": { describe: "Read." } },
    channels: {
        "chat.open": { describe: "Anyone.", schema: z.object({}), reach: "everyone" },
        "chat.said": { describe: "One shop.", schema: z.object({}), reach: "scope" },
        "chat.mine": { describe: "One reader.", schema: z.object({}), reach: "viewer" },
        "chat.held": { describe: "Held back.", schema: z.object({}), reach: "everyone", requires: ["chat.read"] },
    },
});

function who(id: string, shopId?: string, permissions: string[] = []): Identity
{
    return { id, permissions, claims: shopId === undefined ? {} : { shopId } };
}

function sending(channel: string, reach: Pushed["reach"], from?: Identity, within?: string): Pushed
{
    return { channel, message: {}, reach, requires: [], within, from };
}

async function started(): Promise<Kernel>
{
    const kernel = createKernel({ plugins: [chat], db: { of: (plugin) => ({ plugin }), tx: async (_p, run) => run({ plugin: "chat" }) } });

    await kernel.start();

    return kernel;
}

describe("what a push reaches", () =>
{
    test("everyone hears one that says so, signed in or not", async () =>
    {
        const held = sockets(await started(), "shopId");
        const heard: string[] = [];

        held.joined(undefined, (text) => heard.push(text)).listen("chat.open");
        held.push(sending("chat.open", "everyone"));

        expect(heard).toHaveLength(1);
    });

    test("a scope hears only its own", async () =>
    {
        const held = sockets(await started(), "shopId");
        const acme: string[] = [];
        const beta: string[] = [];

        held.joined(who("a", "acme"), (text) => acme.push(text)).listen("chat.said");
        held.joined(who("b", "beta"), (text) => beta.push(text)).listen("chat.said");

        held.push(sending("chat.said", "scope", who("a", "acme"), "acme"));

        expect(acme).toHaveLength(1);
        expect(beta).toHaveLength(0);
    });

    test("a viewer hears every socket of their own, and nobody else's", async () =>
    {
        const held = sockets(await started(), "shopId");
        const mine: string[] = [];
        const theirs: string[] = [];

        held.joined(who("a", "acme"), (text) => mine.push(text)).listen("chat.mine");
        held.joined(who("a", "acme"), (text) => mine.push(text)).listen("chat.mine");
        held.joined(who("b", "acme"), (text) => theirs.push(text)).listen("chat.mine");

        held.push(sending("chat.mine", "viewer", who("a", "acme")));

        expect(mine).toHaveLength(2);
        expect(theirs).toHaveLength(0);
    });

    test("a channel that requires something is refused to whoever lacks it", async () =>
    {
        const held = sockets(await started(), "shopId");

        expect(held.joined(who("a", "acme"), () => undefined).listen("chat.held")).toBe(false);
        expect(held.joined(who("b", "acme", ["chat.read"]), () => undefined).listen("chat.held")).toBe(true);
    });

    test("and nobody hears a channel they never listened to", async () =>
    {
        const held = sockets(await started(), "shopId");
        const heard: string[] = [];

        held.joined(undefined, (text) => heard.push(text));
        held.push(sending("chat.open", "everyone"));

        expect(heard).toHaveLength(0);
    });

    test("nor one they left", async () =>
    {
        const held = sockets(await started(), "shopId");
        const heard: string[] = [];

        const joined = held.joined(undefined, (text) => heard.push(text));

        joined.listen("chat.open");
        joined.left();

        held.push(sending("chat.open", "everyone"));

        expect(heard).toHaveLength(0);
    });

    test("nor a scope channel while carrying no scope at all", async () =>
    {
        const held = sockets(await started(), "shopId");

        expect(held.joined(who("a"), () => undefined).listen("chat.said")).toBe(false);
    });
});
