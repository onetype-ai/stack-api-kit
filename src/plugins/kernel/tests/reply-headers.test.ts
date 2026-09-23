import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, Reply } from "../api";

import type { Definition, Plugin } from "../api";

type Line = { level: string; line: string };

function answering(headers: Readonly<Record<string, string>>, route: Record<string, unknown> = {}): Plugin
{
    return definePlugin("items", {
        version: "1.0.0",
        describe: "Answers with headers of its choosing.",
        routes: [{
            method: "GET",
            path: "/items",
            describe: "Lists items.",
            requires: [],
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handle: () => new Reply(200, { ok: true }, headers),
            ...route,
        }],
    } as Definition);
}

async function headersOf(plugin: Plugin): Promise<{ headers: Readonly<Record<string, string>>; lines: Line[] }>
{
    const lines: Line[] = [];
    const kernel = createKernel({ plugins: [plugin], log: (level, _plugin, line) => lines.push({ level, line }) });

    await kernel.start();

    const answer = await kernel.handle({ method: "GET", path: "/items", input: {}, identity: { id: "someone", permissions: [], claims: {} } });

    return { headers: answer.headers ?? {}, lines };
}

describe("what a reply may say about itself", () =>
{
    test("keeps a header on the kit's short list", async () =>
    {
        const { headers } = await headersOf(answering({ location: "/items/1", "retry-after": "5", vary: "Accept-Language" }));

        expect(headers).toEqual({ location: "/items/1", "retry-after": "5", vary: "Accept-Language", etag: expect.stringMatching(/^W\/"/u) });
    });

    test.each(["content-security-policy", "referrer-policy", "strict-transport-security", "permissions-policy", "cross-origin-opener-policy", "access-control-allow-origin", "content-type", "x-trace"])("drops %s unless the route declares it, and says so", async (name) =>
    {
        const { headers, lines } = await headersOf(answering({ [name]: "anything" }));

        expect(headers[name]).toBeUndefined();
        expect(lines.some((line) => line.level === "warn" && line.line.includes(`"${name}"`))).toBe(true);
    });

    test("keeps a header the route names in sends", async () =>
    {
        const { headers } = await headersOf(answering({ "x-total-count": "42" }, { sends: ["x-total-count"] }));

        expect(headers["x-total-count"]).toBe("42");
    });

    test("never lets a shared cache keep an answer only its caller may see", async () =>
    {
        const { headers, lines } = await headersOf(answering({ "cache-control": "public, max-age=60" }));

        expect(headers["cache-control"]).toBeUndefined();
        expect(lines.some((line) => line.line.includes("shared cache"))).toBe(true);
    });

    test("lets a public route be cached anywhere", async () =>
    {
        const { headers } = await headersOf(answering({ "cache-control": "public, max-age=60" }, { public: true, requires: undefined }));

        expect(headers["cache-control"]).toBe("public, max-age=60");
    });

    test("keeps a private cache-control on any route", async () =>
    {
        const { headers } = await headersOf(answering({ "cache-control": "private, max-age=60" }));

        expect(headers["cache-control"]).toBe("private, max-age=60");
    });
});

describe("a route naming what it sends", () =>
{
    test.each(["content-security-policy", "set-cookie", "access-control-allow-origin", "cross-origin-resource-policy", "sec-fetch-site", "X-Upper", "two words"])("is refused at startup for %s", async (name) =>
    {
        const kernel = createKernel({ plugins: [answering({}, { sends: [name] })] });

        await expect(kernel.start()).rejects.toThrow(`sends "${name}"`);
    });
});
