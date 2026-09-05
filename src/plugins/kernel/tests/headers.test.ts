import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import type { Definition, Plugin } from "../api";

function routeReading(reads?: readonly string[]): Plugin
{
    return definePlugin("probe", {
        version: "1.0.0",
        describe: "Answers what it was allowed to read.",
        routes: [{
            method: "GET",
            path: "/thing",
            describe: "Answers the headers it declared.",
            public: true,
            input: z.object({}),
            output: z.object({ seen: z.array(z.string()), language: z.string() }),
            ...(reads !== undefined && { reads }),
            handle: (_input, ctx) => ({
                seen: Object.keys(ctx.headers).sort(),
                language: ctx.headers["accept-language"] ?? "",
            }),
        }],
    } as Definition);
}

const SENT = {
    "accept-language": "sr-RS,sr;q=0.9,en;q=0.5",
    "x-trace": "abc",
    cookie: "session=secret",
};

describe("what a route may read", () =>
{
    test("hands over a header it declared", async () =>
    {
        const kernel = createKernel({ plugins: [routeReading(["accept-language"])] });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {}, headers: SENT });

        expect(answer.body).toEqual({ seen: ["accept-language"], language: "sr-RS,sr;q=0.9,en;q=0.5" });
    });

    test("withholds every header it did not declare", async () =>
    {
        const kernel = createKernel({ plugins: [routeReading(["accept-language"])] });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {}, headers: SENT });

        expect((answer.body as { seen: string[] }).seen).not.toContain("x-trace");
        expect(JSON.stringify(answer.body)).not.toMatch(/secret/);
    });

    test("hands over nothing when a route declares nothing", async () =>
    {
        const kernel = createKernel({ plugins: [routeReading()] });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {}, headers: SENT });

        expect(answer.body).toEqual({ seen: [], language: "" });
    });

    test("leaves a declared header absent rather than empty when it was not sent", async () =>
    {
        const kernel = createKernel({ plugins: [routeReading(["accept-language", "x-missing"])] });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {}, headers: SENT });

        expect((answer.body as { seen: string[] }).seen).toEqual(["accept-language"]);
    });
});

describe("what a route may never read", () =>
{
    const credentials = ["cookie", "authorization", "proxy-authorization", "set-cookie"];

    for (const header of credentials)
    {
        test(`refuses a route reading "${header}"`, async () =>
        {
            const kernel = createKernel({ plugins: [routeReading([header])] });

            const failed = await kernel.start().then(() => undefined).catch((cause: unknown) => cause as Error);

            expect(failed?.message).toMatch(/carries a credential/);
        });
    }

    test("refuses a header name that is not lowercase", async () =>
    {
        const kernel = createKernel({ plugins: [routeReading(["Accept-Language"])] });

        const failed = await kernel.start().then(() => undefined).catch((cause: unknown) => cause as Error);

        expect(failed?.message).toMatch(/matched lowercase/);
    });
});
