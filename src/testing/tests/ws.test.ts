import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import { definePlugin, Server, start } from "../../index";
import { closeOnce, socketsOf } from "../../plugins/serve/api";

import type { AddressInfo } from "node:net";
import type { StartedApp } from "../../index";
import type { Listening, SocketOptions } from "../../plugins/serve/api";

const APP = "https://app.example.test";

let signedIn = new Set(["k-ana"]);
let granted = new Map<string, readonly string[]>();

const desk = definePlugin("desk", {
    version: "1.0.0",
    describe: "Knows who holds a session, and pushes news to them.",
    identifies: (_ctx, request) =>
    {
        const key = request.headers.get("x-session-key") ?? "";

        return signedIn.has(key) ? { id: key.slice(2), claims: {} } : undefined;
    },
    grants: (_ctx, who) => granted.get(who.id) ?? [],
    channels: {
        "desk.news": { describe: "News for the one reading.", schema: z.object({ text: z.string() }), reach: "viewer" },
        "desk.secret": { describe: "Only for those holding desk.read.", schema: z.object({ text: z.string() }), reach: "viewer", requires: ["desk.read"] },
    },
    permissions: { "desk.read": { describe: "Reads the desk." } },
    routes: [{
        method: "GET",
        path: "/desk/me",
        describe: "Says who is asking.",
        requires: [],
        input: z.object({}),
        output: z.object({ id: z.string() }),
        handle: (_input: unknown, ctx: { identity?: { id: string } }) => ({ id: ctx.identity?.id ?? "" }),
    }],
} as Parameters<typeof definePlugin>[1] & object);

type Opened = { socket: WebSocket; frames: Record<string, unknown>[]; closed: Promise<{ code: number }> };

let app: StartedApp | undefined;
let server: Listening | undefined;

afterEach(async () =>
{
    server?.close();
    await app?.stop();
    app = undefined;
    server = undefined;
    signedIn = new Set(["k-ana"]);
    granted = new Map();
});

async function serving(options: SocketOptions = {}, bodyBytes = 1_000_000): Promise<string>
{
    app = await start({ plugins: [desk], sockets: true, http: { origins: [APP], session: { name: "sid", secure: true }, bodyBytes } });
    server = Server.listen(app, 0, options);

    const listening = server;

    if (!listening.listening)
    {
        await new Promise((resolve) => listening.once("listening", resolve));
    }

    return `ws://127.0.0.1:${String((listening.address() as AddressInfo).port)}/ws`;
}

function opening(url: string, headers: Record<string, string> = { cookie: "sid=k-ana", origin: APP }): Promise<Opened>
{
    const socket = new WebSocket(url, { headers });
    const frames: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number }>((resolve) => socket.on("close", (code) => resolve({ code })));

    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));

    return new Promise((resolve, reject) =>
    {
        socket.once("open", () => resolve({ socket, frames, closed }));
        socket.once("error", reject);
    });
}

async function until(check: () => boolean, ms = 2000): Promise<void>
{
    const end = Date.now() + ms;

    while (!check() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("the socket at /ws", () =>
{
    test("says it is ready, with the connection's id, once the caller is identified", async () =>
    {
        const url = await serving();
        const { frames } = await opening(url);

        await until(() => frames.length > 0);

        expect(frames[0]).toEqual({ channel: "$ready", connection: expect.any(String) });
    });

    test("answers every subscribe, with one code for a channel it may not hear and one that does not exist", async () =>
    {
        const url = await serving();
        const { socket, frames } = await opening(url);

        for (const channel of ["desk.news", "desk.secret", "desk.nothing"])
        {
            socket.send(JSON.stringify({ subscribe: channel }));
        }

        await until(() => frames.length >= 4);

        expect(frames.slice(1)).toEqual([
            { channel: "desk.news", subscribed: true },
            { channel: "desk.secret", error: { code: "CHANNEL_REFUSED" } },
            { channel: "desk.nothing", error: { code: "CHANNEL_REFUSED" } },
        ]);
    });

    test("hears a push for the caller its upgrade identified", async () =>
    {
        const url = await serving();
        const { socket, frames } = await opening(url);

        socket.send(JSON.stringify({ subscribe: "desk.news" }));
        await until(() => frames.length >= 2);
        (app as StartedApp).kernel.context("desk", { id: "ana", permissions: [], claims: {} }).push("desk.news", { text: "hello" });
        await until(() => frames.length >= 3);

        expect(frames[2]).toEqual({ channel: "desk.news", body: { text: "hello" } });
    });

    test("asks a request frame as the caller its upgrade identified", async () =>
    {
        const url = await serving();
        const { socket, frames } = await opening(url);

        socket.send(JSON.stringify({ id: "r1", method: "GET", path: "/desk/me" }));
        await until(() => frames.length >= 2);

        expect(frames[1]).toEqual({ id: "r1", status: 200, body: { id: "ana" } });
    });

    test("closes 4003 an upgrade carrying the session cookie from an origin not allowed, before anything is heard", async () =>
    {
        const url = await serving();
        const { frames, closed } = await opening(url, { cookie: "sid=k-ana", origin: "https://elsewhere.test" });

        expect((await closed).code).toBe(4003);
        expect(frames).toEqual([]);
    });

    test("closes 1009 a frame larger than the http side accepts", async () =>
    {
        const url = await serving({}, 1_000);
        const { socket, closed } = await opening(url);

        socket.send("x".repeat(2_000));

        expect((await closed).code).toBe(1009);
    });

    test("closes 4000 at its lifetime, so the client redials and is checked again", async () =>
    {
        const url = await serving({ lifetimeMs: 100 });
        const { closed } = await opening(url);

        expect((await closed).code).toBe(4000);
    });

    test("closes 4001 once its caller is no longer identified", async () =>
    {
        const url = await serving({ reidentifyMs: 50 });
        const { closed } = await opening(url);

        signedIn = new Set();

        expect((await closed).code).toBe(4001);
    });

    test("stops hearing a channel once its caller no longer holds what it needs, without closing", async () =>
    {
        granted = new Map([["ana", ["desk.read"]]]);

        const url = await serving({ reidentifyMs: 50 });
        const { socket, frames } = await opening(url);

        socket.send(JSON.stringify({ subscribe: "desk.secret" }));
        await until(() => frames.length >= 2);
        granted = new Map();
        await new Promise((resolve) => setTimeout(resolve, 150));
        (app as StartedApp).kernel.context("desk", { id: "ana", permissions: ["desk.read"], claims: {} }).push("desk.secret", { text: "for readers" });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(frames[1]).toEqual({ channel: "desk.secret", subscribed: true });
        expect(frames.some((frame) => frame["channel"] === "desk.secret" && "body" in frame)).toBe(false);
        expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    test("says it is alive with a $ping a browser can count", async () =>
    {
        const url = await serving({ pingMs: 50 });
        const { frames } = await opening(url);

        await until(() => frames.some((frame) => frame["channel"] === "$ping"));

        expect(frames.some((frame) => frame["channel"] === "$ping")).toBe(true);
    });

    test("tells a caller past its sockets how long to wait, then closes 1013", async () =>
    {
        const url = await serving({ mostSocketsPerCaller: 1, backoffMs: 7000 });

        await opening(url);
        const second = await opening(url);

        expect((await second.closed).code).toBe(1013);
        expect(second.frames).toEqual([{ channel: "$backoff", ms: 7000 }]);
    });

    test("closes 1012 every socket when the server stops", async () =>
    {
        const url = await serving();
        const { closed } = await opening(url);
        const running = server as Listening;
        const stopping = app as StartedApp;

        app = undefined;
        server = undefined;
        closeOnce({ server: running, api: stopping, log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, exit: () => undefined, drainMs: 0, sockets: socketsOf(running) })("SIGTERM");

        expect((await closed).code).toBe(1012);
    });
});
