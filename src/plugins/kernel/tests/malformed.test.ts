import { expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

test("a malformed path escape answers, rather than throwing out of handle", async () =>
{
    const kernel = createKernel({
        plugins: [definePlugin("a", {
            version: "1.0.0",
            describe: "The a plugin.",
            routes: [{
                method: "GET",
                path: "/items/:id",
                describe: "Reads one item.",
                public: true,
                input: z.object({ id: z.string() }),
                output: z.object({ id: z.string() }),
                handle: (input) => ({ id: (input as { id: string }).id }),
            }],
        })],
    });

    await kernel.start();

    const answer = await kernel.handle({ method: "GET", path: "/items/%E0%A4%A", input: {} });

    expect(answer.status).toBe(404);
});
