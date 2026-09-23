import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";
import { testClock } from "../testClock";

import type { Context, Definition, Identity, Pipeline, PipelineStep, Plugin } from "../../index";
import type { TestKernel } from "../startTestKernel";

const Draft = z.object({ text: z.string(), marks: z.array(z.string()) });

type Step = PipelineStep<Context>;
type Started = { runId: string; isNew: boolean };

let api: TestKernel | undefined;
let calls: string[] = [];

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
    calls = [];
});

const mark = (label: string): Step => ({
    id: label,
    result: Draft,
    run: (state: z.infer<typeof Draft>, _ctx, step) =>
    {
        calls.push(`${label}:${step.idempotencyKey ?? ""}`);

        return { ...state, marks: [...state.marks, label] };
    },
});

function createPosts(pipeline: Partial<Pipeline<Context>> = {}): Plugin
{
    return definePlugin("posts", {
        version: "1.0.0",
        describe: "Publishes drafts, step by step.",
        scope: { describe: "One workspace's posts.", claim: "workspace", tables: {} },
        pipelines: { "posts.publish": { describe: "Publishes a draft.", input: Draft, output: Draft, flavour: "durable", steps: [mark("render"), mark("check"), mark("store")], ...pipeline } },
    } as Definition);
}

const writer = (workspace: string): Identity => ({ id: `${workspace}-writer`, permissions: [], claims: { workspace } });

async function start(kernel: TestKernel, who: Identity, key?: string): Promise<Started>
{
    return kernel.kernel.context("posts", who).tx(async (inside) => inside.pipeline("posts.publish").run({ text: "hi", marks: [] }, { key }) as Promise<Started>);
}

describe("a durable pipeline", () =>
{
    test("runs each step as scheduled work, handing the next the stored result, and ends done with the output", async () =>
    {
        api = await startTestKernel({ plugins: [createPosts()], schedule: true, outbox: true });
        const { runId } = await start(api, writer("a"));

        await api.drain();

        expect(await api.kernel.context("posts", writer("a")).pipeline("posts.publish").status(runId)).toEqual({ status: "done", output: { text: "hi", marks: ["render", "check", "store"] } });
        expect(calls).toEqual([`render:${runId}:render`, `check:${runId}:check`, `store:${runId}:store`]);
    });

    test("resumes at the first step with no stored result, so a job run again after a crash repeats no finished step", async () =>
    {
        api = await startTestKernel({ plugins: [createPosts()], schedule: true, outbox: true });
        const { runId } = await start(api, writer("a"));
        await api.due();
        await api.due();

        // a step's job taken again after its lease ran out, as a crash leaves it, twice
        await api.kernel.run("posts.publish.step", { runId });
        await api.kernel.run("posts.publish.step", { runId });
        await api.drain();

        expect(calls).toEqual([`render:${runId}:render`, `check:${runId}:check`, `store:${runId}:store`]);
    });

    test("answers the first run for a second one with the same key in the scope, and starts another in another scope", async () =>
    {
        api = await startTestKernel({ plugins: [createPosts()], schedule: true, outbox: true });

        const first = await start(api, writer("a"), "draft-1");
        const again = await start(api, writer("a"), "draft-1");
        const elsewhere = await start(api, writer("b"), "draft-1");

        expect(again).toEqual({ runId: first.runId, isNew: false });
        expect(elsewhere.isNew).toBe(true);
        expect(elsewhere.runId).not.toBe(first.runId);
    });

    test("fails the run at a step past its retries, tells it by event without the fault's text, and retry resumes there", async () =>
    {
        let broken = true;
        const flaky: Step = { id: "check", result: Draft, retries: 2, run: (state: z.infer<typeof Draft>) =>
        {
            if (broken)
            {
                throw new Error("password=hunter2");
            }

            return state;
        } };
        const clock = testClock(0);
        api = await startTestKernel({ plugins: [createPosts({ steps: [mark("render"), flaky, mark("store")] })], schedule: true, outbox: true, now: clock.now });
        const { runId } = await start(api, writer("a"));
        const posts = (): ReturnType<Context["pipeline"]> => api!.kernel.context("posts", writer("a")).pipeline("posts.publish");

        for (let round = 0; round < 4; round += 1)
        {
            await api.due();
            clock.advance(60_000);
        }

        await api.flush();
        const failed = await posts().status(runId);
        const told = api.emittedEvents().filter((seen) => seen.event === "posts.publish.failed");
        broken = false;
        const retried = await api.kernel.context("posts", writer("a")).tx(async (inside) => inside.pipeline("posts.publish").retry(runId));
        await api.drain();

        expect(failed).toEqual({ status: "failed", step: "check" });
        expect(told.map((seen) => seen.payload)).toEqual([{ runId, step: "check", scope: "a", reason: "retries" }]);
        expect(JSON.stringify(told)).not.toContain("hunter2");
        expect(retried).toBe(true);
        expect(await posts().status(runId)).toMatchObject({ status: "done" });
        expect(calls.filter((call) => call.startsWith("render"))).toHaveLength(1);
    });

    test("fails the run once when the schedule gives its step's job up, so no run waits for a job that never comes", async () =>
    {
        const stuck: Step = { id: "check", result: Draft, retries: 1_000, run: () =>
        {
            throw new Error("the provider is down");
        } };
        const clock = testClock(0);
        api = await startTestKernel({ plugins: [createPosts({ steps: [mark("render"), stuck, mark("store")] })], schedule: true, outbox: true, now: clock.now });
        const { runId } = await start(api, writer("a"));

        for (let round = 0; round < 12; round += 1)
        {
            await api.due();
            clock.advance(120_000);
        }

        await api.flush();

        expect(await api.kernel.context("posts", writer("a")).pipeline("posts.publish").status(runId)).toEqual({ status: "failed", step: "check" });
        expect(api.emittedEvents().filter((seen) => seen.event === "posts.publish.failed").map((seen) => seen.payload)).toEqual([{ runId, step: "check", scope: "a", reason: "abandoned" }]);
    });

    test("answers nothing for another scope's run", async () =>
    {
        api = await startTestKernel({ plugins: [createPosts()], schedule: true, outbox: true });
        const { runId } = await start(api, writer("a"));

        expect(await api.kernel.context("posts", writer("b")).pipeline("posts.publish").status(runId)).toBeUndefined();
        expect(await api.kernel.context("posts", writer("b")).tx(async (inside) => inside.pipeline("posts.publish").retry(runId))).toBe(false);
    });
});

describe("a durable pipeline refuses", () =>
{
    test("a run outside a transaction, naming ctx.tx", async () =>
    {
        api = await startTestKernel({ plugins: [createPosts()], schedule: true, outbox: true });

        await expect(api.kernel.context("posts", writer("a")).pipeline("posts.publish").run({ text: "hi", marks: [] })).rejects.toMatchObject({ code: "UNKEPT_JOB", message: expect.stringContaining("inside ctx.tx") });
    });

    test("at start, a step with no result, and no schedule to run on", async () =>
    {
        const unkept = createPosts({ steps: [{ id: "render", run: (state: unknown) => state }] });

        await expect(startTestKernel({ plugins: [unkept], schedule: true })).rejects.toThrow(/step "render" from "posts" declares no result/);
        await expect(startTestKernel({ plugins: [createPosts()] })).rejects.toThrow(/no schedule to run its steps/);
    });
});
