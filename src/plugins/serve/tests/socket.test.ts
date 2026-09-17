import { describe, expect, test } from "vitest";

import { handleSocketMessage } from "../api";

import type { Subscription } from "../../http/api";
import type { StartedApp } from "../../mount/api";

function framing(answer: { status: number; body: unknown } = { status: 200, body: { ok: true } })
{
    const sent: string[] = [];
    const asked: { method: string; path: string; input: unknown; from: string }[] = [];
    const listened: string[] = [];
    const unlistened: string[] = [];

    const api = {
        kernel: {
            handle: (incoming: { method: string; path: string; input: unknown; from: string }) =>
            {
                asked.push(incoming);

                return Promise.resolve(answer);
            },
        },
    } as unknown as StartedApp;

    const subscription = {
        listen: (channel: string) => { listened.push(channel); },
        unlisten: (channel: string) => { unlistened.push(channel); },
        close: () => {},
    } as unknown as Subscription;

    const send = (text: string): void => { sent.push(text); };

    return { api, subscription, send, sent, asked, listened, unlistened };
}

describe("a frame a client sends", () =>
{
    test("subscribes where it asks to, without reaching the kernel", async () =>
    {
        const { api, subscription, send, listened, asked } = framing();

        await handleSocketMessage(api, subscription, JSON.stringify({ subscribe: "notes.changed" }), send);

        expect(listened).toEqual(["notes.changed"]);
        expect(asked).toEqual([]);
    });

    test("and unsubscribes the same way", async () =>
    {
        const { api, subscription, send, unlistened } = framing();

        await handleSocketMessage(api, subscription, JSON.stringify({ unsubscribe: "notes.changed" }), send);

        expect(unlistened).toEqual(["notes.changed"]);
    });

    test("and is answered by the kernel where it carries a request, under the id it asked with", async () =>
    {
        const { api, subscription, send, sent, asked } = framing({ status: 201, body: { id: "one" } });

        await handleSocketMessage(
            api,
            subscription,
            JSON.stringify({ id: "7", method: "POST", path: "/notes", body: { title: "a" } }),
            send,
        );

        expect(asked[0]?.path).toBe("/notes");
        expect(asked[0]?.from).toBe("socket");
        expect(JSON.parse(sent[0] ?? "{}")).toEqual({ id: "7", status: 201, body: { id: "one" } });
    });

    test("and reads query and body together, so either carries what a route takes", async () =>
    {
        const { api, subscription, send, asked } = framing();

        await handleSocketMessage(
            api,
            subscription,
            JSON.stringify({ path: "/notes", query: { kind: "note" }, body: { title: "a" } }),
            send,
        );

        expect(asked[0]?.input).toEqual({ kind: "note", title: "a" });
    });

    test("and defaults to GET on / where it names neither", async () =>
    {
        const { api, subscription, send, asked } = framing();

        await handleSocketMessage(api, subscription, JSON.stringify({}), send);

        expect(asked[0]?.method).toBe("GET");
        expect(asked[0]?.path).toBe("/");
    });

    test("and a frame that is not JSON is answered rather than thrown, so one bad frame never closes the socket", async () =>
    {
        const { api, subscription, send, sent } = framing();

        await expect(handleSocketMessage(api, subscription, "not json at all", send)).resolves.toBeUndefined();

        expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ status: 400 });
    });
});
