import { describe, expect, test } from "vitest";

import { inProcessPubSub, relay, sockets } from "../api";

import type { ChannelMessage, Identity, PubSub } from "../../kernel/api";

// Two processes' socket hubs on one pub/sub, driven as the kernel drives them.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const channels = () => [
    { plugin: "board", channel: "board.cards", reach: "scope" as const, requires: [] },
];

const person = (id: string, workspace: string, permissions: readonly string[] = []): Identity => ({ id, permissions, claims: { workspace } });

function process(pubsub: PubSub)
{
    let told: ReturnType<typeof relay> | undefined;
    const hub = sockets({ channels }, "workspace", () => told?.changed());

    told = relay(hub, pubsub);

    const open = (identity: Identity): unknown[] =>
    {
        const heard: unknown[] = [];

        hub.subscribe(identity, (text) => heard.push(JSON.parse(text))).listen("board.cards");

        return heard;
    };

    return { push: (message: ChannelMessage) => told?.push(message), open, stop: () => told?.stop() };
}

const toWorkspace = (workspace: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
    channel: "board.cards", message: { skip: true }, reach: "scope", requires: [], scope: workspace, from: undefined, fromConnection: undefined, ...extra,
});

describe("a push with variants", () =>
{
    test("gives each socket the first variant it holds the permissions for, else the message, here and in the other process", () =>
    {
        const pubsub = inProcessPubSub();
        const here = process(pubsub);
        const there = process(pubsub);
        const sockets = [here, there].map((side) => ({
            editor: side.open(person("editor", A, ["board.edit", "board.read"])),
            reader: side.open(person("reader", A, ["board.read"])),
            nobody: side.open(person("guest", A)),
        }));

        here.push(toWorkspace(A, {
            variants: [
                { requires: ["board.edit"], message: { set: "full" } },
                { requires: ["board.read"], message: { set: "summary" } },
            ],
        }));

        for (const side of sockets)
        {
            expect(side.editor).toEqual([{ channel: "board.cards", body: { set: "full" } }]);
            expect(side.reader).toEqual([{ channel: "board.cards", body: { set: "summary" } }]);
            expect(side.nobody).toEqual([{ channel: "board.cards", body: { skip: true } }]);
        }

        here.stop();
        there.stop();
    });
});

describe("a frame another process could not have sent", () =>
{
    test.each([
        ["reach scope without a scope", { reach: "scope" }],
        ["reach identity without the one it is to", { reach: "identity", scope: A }],
        ["reach viewer without who pushed", { reach: "viewer" }],
    ])("is dropped, reaching no socket: %s", (_what, forged) =>
    {
        const pubsub = inProcessPubSub();
        const there = process(pubsub);
        const inA = there.open(person("agent", A));
        const inB = there.open(person("agent", B));

        pubsub.publish("kit.push", JSON.stringify({ origin: "forger", channel: "board.cards", requires: [], message: { leaked: true }, ...forged }));

        expect(inA).toEqual([]);
        expect(inB).toEqual([]);

        there.stop();
    });

    test("naming another tenant's scope reaches only that tenant's sockets, never everyone", () =>
    {
        const pubsub = inProcessPubSub();
        const there = process(pubsub);
        const inA = there.open(person("agent", A));
        const inB = there.open(person("agent", B));

        pubsub.publish("kit.push", JSON.stringify({ origin: "forger", channel: "board.cards", reach: "scope", scope: B, requires: [], message: { forB: true } }));

        expect(inA).toEqual([]);
        expect(inB).toEqual([{ channel: "board.cards", body: { forB: true } }]);

        there.stop();
    });
});
