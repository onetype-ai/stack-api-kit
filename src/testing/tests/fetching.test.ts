import { afterEach, describe, expect, test } from "vitest";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { HttpRequest } from "../../index";
import type { TestKernel } from "../startTestKernel";

const partner = definePlugin("partner", {
    version: "1.0.0",
    describe: "Reaches the one host it names.",
    allowedHosts: ["https://api.partner.test"],
});

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

describe("a streamed call through ctx.fetch", () =>
{
    test("answers a stream typed as one, through the same host checks", async () =>
    {
        api = await startTestKernel({
            plugins: [partner],
            respondWith: () => ({ status: 200, headers: {}, body: [new TextEncoder().encode("token")] }),
        });
        const ctx = api.kernel.context("partner");

        const answer = await ctx.fetch({ method: "POST", url: "https://api.partner.test/v1/items", accepts: "stream" });
        const chunks: string[] = [];

        for await (const chunk of answer.body)
        {
            chunks.push(new TextDecoder().decode(chunk));
        }

        expect(chunks).toEqual(["token"]);
        expect(answer.url).toBe("https://api.partner.test/v1/items");
        await expect(ctx.fetch({ method: "GET", url: "https://elsewhere.test/", accepts: "stream" })).rejects.toThrow("which it does not declare");
    });
});

describe("a call's maxBytes through ctx.fetch", () =>
{
    test("reaches the client as the call gave it", async () =>
    {
        const seen: HttpRequest[] = [];

        api = await startTestKernel({
            plugins: [partner],
            respondWith: (call) =>
            {
                seen.push(call);

                return "file";
            },
        });

        await api.kernel.context("partner").fetch({ method: "GET", url: "https://api.partner.test/file", accepts: "text", maxBytes: 100_000_000 });

        expect(seen.map((call) => call.maxBytes)).toEqual([100_000_000]);
    });

    test.each([["not a number", Number.NaN], ["zero", 0], ["a fraction", 1.5]])("is refused as %s, naming the plugin, before anything is dialled", async (_what, given) =>
    {
        api = await startTestKernel({ plugins: [partner] });

        const fetched = api.kernel.context("partner").fetch({ method: "GET", url: "https://api.partner.test/file", maxBytes: given });

        await expect(fetched).rejects.toMatchObject({ code: "INVALID_CALL", message: expect.stringContaining(`"partner" passed maxBytes ${String(given)}`) });
        expect(api.sentRequests()).toEqual([]);
    });
});
