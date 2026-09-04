import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, defineCommand, defineListener, defineParticipant, definePlugin, defineRoute } from "../api";
import type { Context } from "../api";

type Made = Context<{ size: number }, { found: () => string }>;

test("a route written through defineRoute reads its input without a cast", async () =>
{
    const taking = defineRoute<Made>()({
        method: "POST",
        path: "/thing",
        describe: "Takes a title.",
        public: true,
        input: z.object({ title: z.string(), page: z.number() }),
        output: z.object({ title: z.string(), page: z.number() }),
        handle: (given) =>
        {
            const title: string = given.title;
            const page: number = given.page;

            return { title, page };
        },
    });

    const kernel = createKernel({
        plugins: [definePlugin("probe", {
            version: "1.0.0",
            describe: "Reads its own input.",
            config: z.object({ size: z.number().default(1) }),
            services: () => ({ found: () => "x" }),
            routes: [taking],
        })],
    });

    await kernel.start();

    const answer = await kernel.handle({ method: "POST", path: "/thing", input: { title: "a", page: 2 } });

    expect(answer.body).toEqual({ title: "a", page: 2 });
});

test("a route written inline still works, with input unknown", async () =>
{
    const kernel = createKernel({
        plugins: [definePlugin("plain", {
            version: "1.0.0",
            describe: "Writes its route inline.",
            routes: [{
                method: "GET",
                path: "/plain",
                describe: "Answers.",
                public: true,
                input: z.object({}),
                output: z.object({ ok: z.literal(true) }),
                handle: () => ({ ok: true as const }),
            }],
        })],
    });

    await kernel.start();

    await expect(kernel.handle({ method: "GET", path: "/plain", input: {} }))
        .resolves.toMatchObject({ status: 200, body: { ok: true } });
});

test("a listener, participant and command each read their payload without a cast", async () =>
{
    const made = z.object({ id: z.string(), at: z.number() });
    const asked = z.object({ title: z.string() });
    const given = z.object({ ownerId: z.string() });

    const heard: string[] = [];

    const kernel = createKernel({
        plugins: [
            definePlugin("source", {
                version: "1.0.0",
                describe: "Announces and asks.",
                emits: { "source.made": { describe: "Made.", schema: made } },
                hooks: { "source.asking": { describe: "Asks.", schema: asked } },
            }),
            definePlugin("watcher", {
                version: "1.0.0",
                describe: "Hears and answers.",
                permissions: { "watcher.run": { describe: "Run it." } },

                listens: {
                    "source.made": defineListener()(made, {
                        describe: "Records what was made.",
                        handle: (payload) =>
                        {
                            // No cast: id is a string, at is a number.
                            heard.push(`${payload.id}@${String(payload.at)}`);
                        },
                    }),
                },

                participates: {
                    "source.asking": defineParticipant()(asked, {
                        describe: "Refuses an empty title.",
                        handle: (payload) => (payload.title === "" ? "A title is needed." : undefined),
                    }),
                },

                commands: {
                    "watcher.note": defineCommand()({
                        describe: "Notes an owner.",
                        requires: ["watcher.run"],
                        schema: given,
                        run: (input) =>
                        {
                            heard.push(input.ownerId);
                        },
                    }),
                },
            }),
        ],
    });

    await kernel.start();

    kernel.context("source").events.emit("source.made", { id: "a", at: 1 });

    await expect(kernel.context("source").hooks.run("source.asking", { title: "" }))
        .resolves.toBe("A title is needed.");

    await kernel.run("watcher.note", { ownerId: "u1" }, { id: "u1", permissions: ["watcher.run"], claims: {} });

    expect(heard).toEqual(["a@1", "u1"]);
});

describe("finding a route", () =>
{
    async function serving()
    {
        const kernel = createKernel({
            plugins: [definePlugin("probe", {
                version: "1.0.0",
                describe: "Answers one thing.",
                routes: [
                    defineRoute()({
                        method: "GET",
                        path: "/things/:documentId",
                        describe: "Answers one.",
                        public: true,
                        input: z.object({ documentId: z.string() }),
                        output: z.object({ documentId: z.string() }),
                        handle: (given) => ({ documentId: given.documentId }),
                    }),
                    defineRoute()({
                        method: "GET",
                        path: "/things",
                        describe: "Lists them.",
                        public: true,
                        input: z.object({}),
                        output: z.object({ listed: z.literal(true) }),
                        handle: () => ({ listed: true as const }),
                    }),
                ],
            })],
        });

        await kernel.start();

        return kernel;
    }

    test("takes the path a caller actually asked for", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({ method: "GET", path: "/things/abc", input: {} });

        expect(answer.body).toEqual({ documentId: "abc" });
    });

    test("still takes the declared path with its parameters in input", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({
            method: "GET",
            path: "/things/:documentId",
            input: { documentId: "abc" },
        });

        expect(answer.body).toEqual({ documentId: "abc" });
    });

    test("lets the real path win over a body claiming otherwise", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({
            method: "GET",
            path: "/things/mine",
            input: { documentId: "yours" },
        });

        expect(answer.body).toEqual({ documentId: "mine" });
    });

    test("decodes what a path segment carried", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({ method: "GET", path: "/things/a%20b", input: {} });

        expect(answer.body).toEqual({ documentId: "a b" });
    });

    test("prefers the literal path over one that only matches by parameter", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({ method: "GET", path: "/things", input: {} });

        expect(answer.body).toEqual({ listed: true });
    });

    test("still answers 404 for a path nothing declared", async () =>
    {
        const kernel = await serving();

        const answer = await kernel.handle({ method: "GET", path: "/things/a/b", input: {} });

        expect(answer.status).toBe(404);
    });
});
