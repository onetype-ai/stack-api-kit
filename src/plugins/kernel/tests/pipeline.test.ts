import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

import type { Context, Definition, Identity, Pipeline, PipelineStep, Plugin } from "../api";

function createPlugin(name: string, definition: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, { version: "1.0.0", describe: `The ${name} plugin.`, ...definition } as Definition);
}

const Draft = z.object({ text: z.string(), marks: z.array(z.string()) });

type Step = PipelineStep<Context>;

const mark = (label: string): Step["run"] => (state: z.infer<typeof Draft>) => ({ ...state, marks: [...state.marks, label] });

function createPosts(pipeline: Partial<Pipeline<Context>> = {}, definition: Partial<Definition> = {}): Plugin
{
    return createPlugin("posts", {
        pipelines: {
            "posts.publish": {
                describe: "Turns a draft into a published post.",
                input: Draft,
                output: Draft,
                steps: [{ id: "validate", run: mark("validate") }, { id: "store", run: mark("store") }],
                ...pipeline,
            },
        },
        ...definition,
    });
}

const createAdder = (name: string, steps: Step[]): Plugin => createPlugin(name, { dependsOn: ["posts"], adds: { "posts.publish": steps } });

describe("a pipeline", () =>
{
    test("runs the owner's steps and the added ones beside their anchors, the same whatever order plugins load in", async () =>
    {
        const plugins = [
            createAdder("moderation", [{ id: "moderate", after: "validate", run: mark("moderate") }]),
            createAdder("links", [{ id: "shorten", after: "validate", run: mark("shorten") }, { id: "preview", before: "store", run: mark("preview") }]),
            createPosts(),
        ];
        const kernel = createKernel({ plugins });
        const reversed = createKernel({ plugins: [...plugins].reverse() });
        await kernel.start();
        await reversed.start();

        const published = await kernel.context("moderation").pipeline("posts.publish").run({ text: "hi", marks: [] });

        expect(published).toEqual({ text: "hi", marks: ["validate", "shorten", "moderate", "preview", "store"] });
        expect(kernel.explain("posts.publish").map((step) => step.id)).toEqual(reversed.explain("posts.publish").map((step) => step.id));
        expect(kernel.explain("posts.publish")[1]).toEqual({ id: "shorten", owner: "links", anchor: { after: "validate" } });
    });

    test("hands each step its own plugin's context, for the same caller", async () =>
    {
        const seen: string[] = [];
        const record: Step["run"] = (state, ctx: Context) =>
        {
            seen.push(`${ctx.name}:${ctx.identity?.id ?? "nobody"}`);

            return state;
        };
        const kernel = createKernel({ plugins: [createPosts({ steps: [{ id: "own", run: record }] }), createAdder("links", [{ id: "added", after: "own", run: record }])] });
        await kernel.start();
        const alice: Identity = { id: "alice", permissions: [], claims: {} };

        await kernel.context("links", alice).pipeline("posts.publish").run({ text: "hi", marks: [] });

        expect(seen).toEqual(["posts:alice", "links:alice"]);
    });

    test("ends early when a step stops it with an output", async () =>
    {
        const kernel = createKernel({ plugins: [createPosts(), createAdder("cache", [{ id: "cached", after: "validate", run: (_state, _ctx, step) => step.stop({ text: "from cache", marks: [] }) }])] });
        await kernel.start();

        const published = await kernel.context("cache").pipeline("posts.publish").run({ text: "hi", marks: [] });

        expect(published).toEqual({ text: "from cache", marks: [] });
    });

    test("logs its order at start and each step as it runs, never the state", async () =>
    {
        const logged: string[] = [];
        const kernel = createKernel({ plugins: [createPosts()], log: (level, _plugin, line, about) => logged.push(`${level} ${line} ${JSON.stringify(about ?? {})}`) });
        await kernel.start();

        await kernel.context("posts").pipeline("posts.publish").run({ text: "secret", marks: [] });

        expect(logged.some((line) => line.startsWith("debug pipeline \"posts.publish\" runs validate → store"))).toBe(true);
        expect(logged.some((line) => line.startsWith("debug pipeline \"posts.publish\" step \"store\" ok"))).toBe(true);
        expect(logged.join("\n")).not.toContain("secret");
    });
});

describe("a pipeline refuses", () =>
{
    test("at start, an unknown anchor and a taken id, together", async () =>
    {
        const kernel = createKernel({ plugins: [createPosts(), createAdder("links", [
            { id: "a", after: "nowhere", run: mark("a") },
            { id: "store", after: "validate", run: mark("again") },
        ])] });

        const refused = String(await kernel.start().catch((error: unknown) => error));

        expect(refused).toContain("sits beside \"nowhere\", which no step is named");
        expect(refused).toContain("two steps named \"store\"");
    });

    test("at start, an anchor cycle, naming each step in it", async () =>
    {
        const kernel = createKernel({ plugins: [createPosts(), createAdder("loops", [{ id: "x", after: "y", run: mark("x") }, { id: "y", after: "x", run: mark("y") }])] });

        const refused = String(await kernel.start().catch((error: unknown) => error));

        expect(refused).toContain("Step \"x\" from \"loops\" in pipeline \"posts.publish\" is in an anchor cycle");
        expect(refused).toContain("Step \"y\" from \"loops\"");
    });

    test("input or output its schemas refuse, and a failing step, naming it", async () =>
    {
        const kernel = createKernel({ plugins: [createPosts(), createAdder("broken", [{ id: "explode", after: "validate", run: () =>
        {
            throw new Error("disk full");
        } }])] });
        const lossy = createKernel({ plugins: [createPosts({ steps: [{ id: "drop", run: () => ({ text: 1 }) }] })] });
        await kernel.start();
        await lossy.start();

        const badInput = await kernel.context("posts").pipeline("posts.publish").run({ text: 1 }).catch((error: unknown) => error);
        const failed = await kernel.context("posts").pipeline("posts.publish").run({ text: "hi", marks: [] }).catch((error: unknown) => error);
        const badOutput = await lossy.context("posts").pipeline("posts.publish").run({ text: "hi", marks: [] }).catch((error: unknown) => error);

        expect(badInput).toMatchObject({ code: "INVALID_PAYLOAD" });
        expect(failed).toMatchObject({ code: "PIPELINE_FAILED", plugin: "broken", message: "Pipeline \"posts.publish\" stopped at step \"explode\" from \"broken\": disk full" });
        expect(badOutput).toMatchObject({ code: "INVALID_PAYLOAD", message: expect.stringContaining("The last step to run must answer the output") });
    });

    test("to tell a caller why a step failed: a route answers a neutral 500", async () =>
    {
        const route = { method: "POST" as const, path: "/posts", describe: "Publishes.", public: true, input: Draft, output: Draft, handle: (input: unknown, ctx: Context) => ctx.pipeline("posts.publish").run(input) };
        const kernel = createKernel({ plugins: [createPosts({ steps: [{ id: "explode", run: () =>
        {
            throw new Error("password=hunter2 at db-7");
        } }] }, { routes: [route] })] });
        await kernel.start();

        const answer = await kernel.handle({ method: "POST", path: "/posts", input: { text: "hi", marks: [] } });

        expect(answer.status).toBe(500);
        expect(JSON.stringify(answer.body)).not.toContain("hunter2");
        expect(JSON.stringify(answer.body)).not.toContain("explode");
    });

    test("a step from a plugin that does not depend on the owner, and a run by one", async () =>
    {
        const stray = createPlugin("stray", { adds: { "posts.publish": [{ id: "x", after: "validate", run: mark("x") }] } });
        const refusing = createKernel({ plugins: [createPosts(), stray] });
        const running = createKernel({ plugins: [createPosts(), createPlugin("stray")] });
        await running.start();

        await expect(refusing.start()).rejects.toThrow(/belongs to "posts", which "stray" does not depend on/);
        expect(() => running.context("stray").pipeline("posts.publish")).toThrow(/Add "posts" to dependsOn/);
    });
});
