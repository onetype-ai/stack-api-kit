import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, inProcessPubSub, start } from "../../index";
import { openStore } from "../../plugins/database/tests/openStore";
import { createIdentity } from "../startTestKernel";

import type { Identity, PubSub, StartedApp, Subscription } from "../../index";

// Two processes serving one application, sharing what they tell each other: here two apps in one test.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const desk = definePlugin("desk", {
    version: "1.0.0",
    describe: "Replies to one person, and tells the workspace its queue.",
    scope: { describe: "A workspace's desk.", claim: "workspace", tables: {} },
    permissions: { "desk.answer": { describe: "Answer at the desk." } },
    channels: {
        "desk.reply": { describe: "A reply for one person.", schema: z.object({ text: z.string() }), reach: "identity" },
        "desk.queue": { describe: "The workspace's queue.", schema: z.object({ size: z.number() }), reach: "scope" },
    },
});

let apps: StartedApp[] = [];

afterEach(async () =>
{
    for (const app of apps.splice(0))
    {
        await app.stop();
    }
});

const person = (id: string, workspace: string, permissions: readonly string[] = []): Identity => createIdentity(permissions, id, { workspace });

type Line = { level: string; line: string; about: unknown };

const serve = async (pubsub: PubSub, lines: Line[] = []): Promise<StartedApp> =>
{
    const record = (level: string) => (line: string, about?: Readonly<Record<string, unknown>>): void =>
    {
        lines.push({ level, line, about });
    };
    const app = await start({ plugins: [desk], sockets: { claim: "workspace" }, pubsub, log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } });

    apps.push(app);

    return app;
};

const open = (running: StartedApp, identity: Identity, channel: string): { heard: unknown[]; socket: Subscription } =>
{
    const heard: unknown[] = [];
    const socket = running.sockets!.subscribe(identity, (text) =>
    {
        heard.push(JSON.parse(text));
    });

    socket.listen(channel);

    return { heard, socket };
};

describe("a push from one process", () =>
{
    test("reaches the pusher's workspace in the other process, and never another workspace's socket", async () =>
    {
        const pubsub = inProcessPubSub();
        const first = await serve(pubsub);
        const second = await serve(pubsub);
        const sameWorkspace = open(second, person("agent-1", A), "desk.queue");
        const otherWorkspace = open(second, person("agent-2", B), "desk.queue");

        first.kernel.context("desk", person("agent-3", A)).push("desk.queue", { size: 4 });

        expect(sameWorkspace.heard).toEqual([{ channel: "desk.queue", body: { size: 4 } }]);
        expect(otherWorkspace.heard).toEqual([]);
    });

    test("to one identity reaches only that person, in the pusher's workspace", async () =>
    {
        const pubsub = inProcessPubSub();
        const first = await serve(pubsub);
        const second = await serve(pubsub);
        const named = open(second, person("visitor-1", A), "desk.reply");
        const bystander = open(second, person("visitor-2", A), "desk.reply");
        const sameIdOtherWorkspace = open(second, person("visitor-1", B), "desk.reply");

        first.kernel.context("desk", person("agent-1", A)).push("desk.reply", { text: "hello" }, { to: "visitor-1" });

        expect(named.heard).toEqual([{ channel: "desk.reply", body: { text: "hello" } }]);
        expect(bystander.heard).toEqual([]);
        expect(sameIdOtherWorkspace.heard).toEqual([]);
    });

    test("reaches the pushing process's own sockets once, not again through the others", async () =>
    {
        const pubsub = inProcessPubSub();
        const first = await serve(pubsub);
        await serve(pubsub);
        const local = open(first, person("agent-1", A), "desk.queue");

        first.kernel.context("desk", person("agent-2", A)).push("desk.queue", { size: 1 });

        expect(local.heard).toHaveLength(1);
    });
});

describe("who is present", () =>
{
    test("counts a socket open in the other process, in the asking workspace alone", async () =>
    {
        const pubsub = inProcessPubSub();
        const first = await serve(pubsub);
        const second = await serve(pubsub);

        open(second, person("agent-1", A, ["desk.answer"]), "desk.queue");
        open(second, person("agent-2", B, ["desk.answer"]), "desk.queue");

        expect(first.kernel.context("desk", person("agent-3", A)).presence.connected("desk.answer")).toEqual(["agent-1"]);
    });

    test("forgets a socket the other process closed", async () =>
    {
        const pubsub = inProcessPubSub();
        const first = await serve(pubsub);
        const second = await serve(pubsub);
        const { socket } = open(second, person("agent-1", A, ["desk.answer"]), "desk.queue");

        socket.close();

        expect(first.kernel.context("desk", person("agent-3", A)).presence.connected("desk.answer")).toEqual([]);
    });
});

describe("a frame that is not what the kit sends", () =>
{
    test.each([
        ["text that is no JSON", "{not json"],
        ["a push with a field the kit never writes", JSON.stringify({ origin: "x", channel: "desk.queue", reach: "everyone", requires: [], message: {}, extra: 1 })],
        ["a push reaching a socket by its connection", JSON.stringify({ origin: "x", channel: "desk.queue", reach: "connection", requires: [], message: {} })],
    ])("is dropped, reaches nobody, and is logged once without its text: %s", async (_what, frame) =>
    {
        const pubsub = inProcessPubSub();
        const lines: Line[] = [];
        const receiving = await serve(pubsub, lines);
        const listener = open(receiving, person("agent-1", A), "desk.queue");

        pubsub.publish("kit.push", frame);
        pubsub.publish("kit.push", frame);

        const warned = lines.filter((line) => line.line.includes("was not what the kit sends"));

        expect(listener.heard).toEqual([]);
        expect(warned).toHaveLength(1);
        expect(JSON.stringify(warned)).not.toContain(frame);
    });
});

describe("a dead letter one process puts back", () =>
{
    // the beat is 5 s; delivery within 2 s is the wake-up's doing
    test("is delivered by another process at once, not at its next beat", async () =>
    {
        const heard: string[] = [];
        const orders = definePlugin("orders", {
            version: "1.0.0",
            describe: "Announces an order.",
            emits: { "orders.placed": { describe: "An order was placed.", schema: z.object({ id: z.string() }) } },
        });
        const ledger = definePlugin("ledger", {
            version: "1.0.0",
            describe: "Records an order.",
            listens: { "orders.placed": { describe: "Records it.", handle: (payload: unknown) => { heard.push((payload as { id: string }).id); } } },
        });
        const store = await openStore({});
        const earlier = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");
        const pubsub = inProcessPubSub();

        // a process gave this event up long ago: it waits as a dead letter
        await earlier.save(undefined, [{ id: "dead-1", plugin: "orders", name: "orders.placed", payload: { id: "order-1" } }]);
        await earlier.markDead?.("dead-1", [], 8, Date.now());

        const putting = await start({ plugins: [orders, ledger], database: store, outbox: true, sockets: false, pubsub });
        const delivering = await start({ plugins: [orders, ledger], database: store, outbox: true, sockets: false, pubsub });

        apps.push(putting, delivering);

        expect(await putting.kernel.work.retryFailed("dead-1")).toBe(true);

        const end = Date.now() + 2_000;

        while (heard.length === 0 && Date.now() < end)
        {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(heard).toEqual(["order-1"]);
    });
});
