import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Refusal, Server, start } from "../../index";

import type { Server as HttpServer } from "node:http";
import type { StartedApp } from "../../index";
import { testDatabase } from "./testDatabase";


const route = defineRoute();
const Fields = z.object({ payload: z.string().optional(), command: z.string().optional(), text: z.string().optional(), channel: z.union([z.string(), z.array(z.string())]).optional() });
const SECRET = "partner-signing-secret";

let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

const signatureOf = (timestamp: string, raw: string): string =>
{
    return `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
};

const partner = definePlugin("partner", {
    version: "1.0.0",
    describe: "Hears Partner's interactions, checking each signature first.",
    routes: [
        route({
            method: "POST",
            path: "/integrations/:provider/interactions",
            describe: "A Partner interaction or slash command, signed.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            accepts: "urlencoded",
            keepsRaw: true,
            reads: ["x-partner-signature", "x-partner-request-timestamp"],
            input: z.object({ provider: z.string(), toString: z.string().optional() }).extend(Fields.shape),
            output: z.object({ provider: z.string(), fields: Fields, named: z.string() }),
            handle: (input, ctx) =>
            {
                const raw = new TextDecoder().decode(ctx.sent);

                if (ctx.headers["x-partner-signature"] !== signatureOf(ctx.headers["x-partner-request-timestamp"] ?? "", raw))
                {
                    throw new Refusal(401, "SIGNATURE_INVALID", "The signature does not match the body.");
                }

                const { provider, toString: named, ...fields } = input;

                return { provider, fields, named: typeof named === "string" ? named : "not sent" };
            },
        }),
    ],
});

const serve = async (bodyBytes = 2_000): Promise<string> =>
{
    app = await start({ plugins: [partner], database: await testDatabase(), sockets: false, http: { bodyBytes } });
    const server = Server.listen(app, 0) as HttpServer;

    if (!server.listening)
    {
        await new Promise((resolve) => server.once("listening", resolve));
    }

    const { port } = server.address() as { port: number };
    const stopping = app.stop;
    app = { ...app, stop: async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await stopping();
    } };

    return `http://127.0.0.1:${String(port)}`;
};

const post = (base: string, raw: string, headers: Record<string, string> = {}): Promise<Response> =>
{
    return fetch(`${base}/integrations/partner/interactions`, {
        method: "POST",
        body: raw,
        headers: { connection: "close", "content-type": "application/x-www-form-urlencoded", "x-partner-request-timestamp": "1700000000", "x-partner-signature": signatureOf("1700000000", raw), ...headers },
    });
};

describe("a route reading a URL-encoded form", () =>
{
    test("checks the signature over the bytes as they arrived, then reads the fields decoded, the path's too", async () =>
    {
        const base = await serve();
        const raw = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: "U1" } }))}`;

        const response = await post(base, raw);

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ provider: "partner", fields: { payload: "{\"type\":\"block_actions\",\"user\":{\"id\":\"U1\"}}" }, named: "not sent" });
    });

    test("reads a slash command, a plus as a space and a name sent twice as a list", async () =>
    {
        const base = await serve();

        const response = await post(base, "command=%2Fonetype&text=ask+about+refunds&channel=C1&channel=C2");

        expect(await response.json()).toEqual({ provider: "partner", fields: { command: "/onetype", text: "ask about refunds", channel: ["C1", "C2"] }, named: "not sent" });
    });

    test("refuses a body whose signature does not match, however it was encoded", async () =>
    {
        const base = await serve();

        const response = await post(base, "text=ask", { "x-partner-signature": signatureOf("1700000000", "text=other") });

        expect(response.status).toBe(401);
    });

    test("never lets a field reach the prototype", async () =>
    {
        const base = await serve();

        const response = await post(base, "__proto__=polluted&constructor=x&text=ok");

        expect(await response.json()).toEqual({ provider: "partner", fields: { text: "ok" }, named: "not sent" });
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });

    test("reads a name no object should inherit as the plain string it was sent as", async () =>
    {
        const base = await serve();

        const response = await post(base, "toString=a&text=ok");

        expect(await response.json()).toEqual({ provider: "partner", fields: { text: "ok" }, named: "a" });
    });

    test("keeps a name sent a thousand times, read in time proportional to the form", async () =>
    {
        const base = await serve(1_000_000);
        const raw = Array.from({ length: 1_000 }, (_unused, at) => `channel=C${String(at)}`).join("&");

        const response = await post(base, raw);
        const channels = ((await response.json()) as { fields: { channel: string[] } }).fields.channel;

        expect(channels).toHaveLength(1_000);
        expect(channels.at(-1)).toBe("C999");
    });

    test("refuses a form of more than a thousand fields with 413, before reading them all", async () =>
    {
        const base = await serve(1_000_000);
        const started = performance.now();

        const response = await post(base, "a=1&".repeat(50_000));

        expect(response.status).toBe(413);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    test("refuses JSON, or another content type, with 415", async () =>
    {
        const base = await serve();

        const response = await post(base, "{\"text\":\"ok\"}", { "content-type": "application/json" });

        expect(response.status).toBe(415);
        expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_BODY" });
    });

    test("refuses a body past the server's size with 413", async () =>
    {
        const base = await serve();

        const response = await post(base, `text=${"a".repeat(3_000)}`);

        expect(response.status).toBe(413);
    });
});
