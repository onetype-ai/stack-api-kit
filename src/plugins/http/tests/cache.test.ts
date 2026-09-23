import { expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, Reply } from "../../kernel/api";
import { serve } from "../api";

import type { Definition } from "../../kernel/api";

async function appAnswering(headers: Readonly<Record<string, string>>): Promise<ReturnType<typeof serve>>
{
    const kernel = createKernel({
        plugins: [definePlugin("items", {
            version: "1.0.0",
            describe: "Answers with a cache policy of its own.",
            routes: [{
                method: "GET",
                path: "/items",
                describe: "Lists items.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                handle: () => new Reply(200, { ok: true }, headers),
            }],
        } as Definition)],
    });

    await kernel.start();

    return serve({ kernel });
}

test("a cache-control the reply chose reaches the wire over the kit's no-store", async () =>
{
    const app = await appAnswering({ "cache-control": "public, max-age=60" });

    const response = await app.fetch(new Request("http://localhost/items"));

    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
});

test("an answer that chose none still leaves no-store", async () =>
{
    const app = await appAnswering({});

    const response = await app.fetch(new Request("http://localhost/items"));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
});
