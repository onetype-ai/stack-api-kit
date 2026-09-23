import { createServer } from "node:net";

import { describe, expect, test } from "vitest";

import { httpClient } from "../api";

describe("the built-in client given a pinned address", () =>
{
    test("connects to that address even for a name that resolves nowhere", async () =>
    {
        let connected = false;
        const server = createServer((socket) =>
        {
            connected = true;
            socket.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as { port: number };
        const call = httpClient({ timeoutMs: 2000 });

        try
        {
            // `.invalid` never resolves (RFC 2606): reaching the server proves the pin was used.
            await expect(call({ method: "GET", url: `https://pinned.invalid:${String(port)}/` }, { address: "127.0.0.1", family: 4 })).rejects.toMatchObject({ code: "NETWORK" });
        }
        finally
        {
            await new Promise((resolve) => server.close(resolve));
        }

        expect(connected).toBe(true);
    });
});
