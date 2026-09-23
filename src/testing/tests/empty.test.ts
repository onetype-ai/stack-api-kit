import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute, Reply, Server, SessionHeaders, start } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { Server as HttpServer } from "node:http";
import type { StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";

const route = defineRoute();

const things = definePlugin("things", {
    version: "1.0.0",
    describe: "Answers without a body.",
    routes: [
        route({
            method: "DELETE",
            path: "/things",
            describe: "Answers 204 and, by mistake, a body.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.object({}),
            handle: () =>
            {
                return new Reply(204, {});
            },
        }),
        route({
            method: "POST",
            path: "/things/out",
            describe: "Signs out with a 204.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.null(),
            handle: () =>
            {
                return new Reply(204, null, { [SessionHeaders.end]: "1" });
            },
        }),
        route({
            method: "PUT",
            path: "/things",
            describe: "Answers 205 with nothing, as it should.",
            public: true,
            limit: { requests: 100, seconds: 60 },
            input: z.object({}),
            output: z.null(),
            handle: () =>
            {
                return new Reply(205, null);
            },
        }),
    ],
});

let api: TestKernel | undefined;
let app: StartedApp | undefined;

afterEach(async () =>
{
    await api?.stop();
    await app?.stop();
    api = undefined;
    app = undefined;
});

describe("a status that carries no body", () =>
{
    test("drops a body a 204 reply wrote, and says so in the log", async () =>
    {
        api = await startTestKernel({ plugins: [things] });

        const answer = await api.kernel.handle({ method: "DELETE", path: "/things", input: {} });

        expect(answer.status).toBe(204);
        expect(answer.body).toBeNull();
        expect(api.logLines.some((line) => line.line.includes("answered 204 with a body"))).toBe(true);
    });

    test("answers a 205 with no body quietly", async () =>
    {
        api = await startTestKernel({ plugins: [things] });

        const answer = await api.kernel.handle({ method: "PUT", path: "/things", input: {} });

        expect(answer.status).toBe(205);
        expect(api.logLines.some((line) => line.line.includes("with a body"))).toBe(false);
    });

    const serving = async (withSession = true): Promise<number> =>
    {
        app = await start({ plugins: [things], database: { file: ":memory:" }, sockets: false, ...(withSession && { http: { session: { name: "sid", secure: true } } }) });
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

        return port;
    };

    test("reaches the wire as an empty 204, never a 500", async () =>
    {
        const port = await serving();

        const response = await fetch(`http://127.0.0.1:${String(port)}/things`, { method: "DELETE" });

        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
    });

    test("still turns the session headers of a 204 into a cookie, and never sends them", async () =>
    {
        const port = await serving();

        const response = await fetch(`http://127.0.0.1:${String(port)}/things/out`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toContain("sid=; Path=/; HttpOnly");
        expect(response.headers.get(SessionHeaders.end)).toBeNull();
    });

    test("passes the session headers of a 204 through untouched where no session is configured", async () =>
    {
        const port = await serving(false);

        const response = await fetch(`http://127.0.0.1:${String(port)}/things/out`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

        expect(response.status).toBe(204);
        expect(response.headers.get(SessionHeaders.end)).toBe("1");
        expect(response.headers.get("set-cookie")).toBeNull();
    });
});
