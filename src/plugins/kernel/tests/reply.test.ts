import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Reply, createKernel, definePlugin } from "../api";
import type { Definition, Kernel } from "../api";

async function startServer(handle: () => unknown, lines: unknown[] = []): Promise<Kernel>
{
    const kernel = createKernel({
        plugins: [definePlugin("probe", {
            version: "1.0.0",
            describe: "Answers with a status of its own.",
            routes: [{
                method: "GET",
                path: "/thing",
                describe: "Answers.",
                public: true,
                input: z.object({}),
                output: z.object({ to: z.string() }),
                handle,
            }],
        } as Definition)],
        log: (level, plugin, line, about) =>
        {
            lines.push({ level, plugin, line, ...about });
        },
    });

    await kernel.start();

    return kernel;
}

describe("a handler saying what its answer carries", () =>
{
    test("sends the status and headers it named", async () =>
    {
        const kernel = await startServer(() => new Reply(302, { to: "/elsewhere" }, { location: "/elsewhere" }));

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {} });

        expect(answer).toEqual({
            status: 302,
            body: { to: "/elsewhere" },
            headers: { location: "/elsewhere" },
        });
    });

    test("redirects temporarily by default and permanently when asked", async () =>
    {
        const once = await startServer(() => Reply.redirect("/elsewhere"));
        const permanent = await startServer(() => Reply.redirect("/elsewhere", true));

        expect((await once.handle({ method: "GET", path: "/thing", input: {} })).status).toBe(307);
        expect((await permanent.handle({ method: "GET", path: "/thing", input: {} })).status).toBe(308);
    });

    test("still filters the body through the output schema", async () =>
    {
        const kernel = await startServer(() => new Reply(302, { to: "/elsewhere", secret: "LEAK" }, {}));

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {} });

        expect(answer.body).toEqual({ to: "/elsewhere" });
    });

    test("answers 500 when the body it carries fails the schema", async () =>
    {
        const kernel = await startServer(() => new Reply(302, { wrong: true }, {}));

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {} });

        expect(answer.status).toBe(500);
    });

    test("leaves a plain return answering as it always did", async () =>
    {
        const kernel = await startServer(() => ({ to: "/elsewhere" }));

        const answer = await kernel.handle({ method: "GET", path: "/thing", input: {} });

        expect(answer).toEqual({ status: 200, body: { to: "/elsewhere" }, headers: { etag: expect.stringMatching(/^W\/"/u) } });
    });
});
