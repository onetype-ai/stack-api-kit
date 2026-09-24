import { createServer } from "node:net";

import { afterEach, expect, test } from "vitest";

import { definePlugin, Server, start } from "../../index";
import { testDatabase } from "./testDatabase";

import type { Server as HttpServer } from "node:http";
import type { StartedApp } from "../../index";

let app: StartedApp | undefined;
let server: HttpServer | undefined;

afterEach(async () =>
{
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    await app?.stop();
    app = undefined;
    server = undefined;
});

// a service another program runs on the same machine must never answer what a test asks its own server
test("a test server on the address it dials holds its port there, so no other process can answer in its place", async () =>
{
    app = await start({ plugins: [definePlugin("quiet", { version: "1.0.0", describe: "Declares nothing." })], database: await testDatabase(), sockets: false });
    server = Server.listen(app, 0, { hostname: "127.0.0.1" }) as HttpServer;

    if (!server.listening)
    {
        await new Promise((resolve) => server?.once("listening", resolve));
    }

    const { address, port } = server.address() as { address: string; port: number };
    const intruder = createServer();

    const taken = await new Promise<string>((resolve) =>
    {
        intruder.once("error", (cause: NodeJS.ErrnoException) => resolve(cause.code ?? "error"));
        intruder.listen(port, "127.0.0.1", () => resolve("bound"));
    });

    intruder.close();

    expect(address).toBe("127.0.0.1");
    expect(taken).toBe("EADDRINUSE");
});
