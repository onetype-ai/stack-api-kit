import { describe, expect, test } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";

import { schedule } from "../../database/api";
import { createKernel, definePlugin } from "../api";

import type { Plugin } from "../api";

function createScheduled(ran: string[], throwsFirst = false): Plugin
{
    let tries = 0;

    return definePlugin("holds", {
        version: "1.0.0",
        describe: "Asks for work later.",
        commands: {
            "holds.release": {
                describe: "Releases a hold.",
                schema: z.object({ id: z.string() }),
                run: (input) =>
                {
                    tries += 1;

                    if (throwsFirst && tries === 1)
                    {
                        throw new Error("the partner was down");
                    }

                    ran.push((input as { id: string }).id);
                },
            },
        },
    });
}

describe("work asked for later", () =>
{
    test("does not run before its time, and runs after it", async () =>
    {
        const connection = new Database(":memory:");
        const jobs = schedule(connection);
        const ran: string[] = [];

        let clock = 1_000_000;

        const kernel = createKernel({
            plugins: [createScheduled(ran)],
            schedule: jobs,
            now: () => clock,
            beat: 5,
        });

        await kernel.start();

        kernel.context("holds").commands.later("holds.release", { id: "one" }, 600);

        await new Promise((done) => setTimeout(done, 30));

        expect(ran).toEqual([]);

        clock += 601_000;

        await new Promise((done) => setTimeout(done, 30));

        expect(ran).toEqual(["one"]);

        await kernel.stop();
        connection.close();
    });

    test("is tried again when it throws", async () =>
    {
        const connection = new Database(":memory:");
        const jobs = schedule(connection);
        const ran: string[] = [];

        let clock = 1_000_000;

        const kernel = createKernel({
            plugins: [createScheduled(ran, true)],
            schedule: jobs,
            now: () => clock,
            beat: 5,
        });

        await kernel.start();

        kernel.context("holds").commands.later("holds.release", { id: "two" }, 0);

        await new Promise((done) => setTimeout(done, 30));

        expect(ran).toEqual([]);

        // Past the backoff.
        clock += 5_000;

        await new Promise((done) => setTimeout(done, 30));

        expect(ran).toEqual(["two"]);

        await kernel.stop();
        connection.close();
    });

    test("gives up after enough attempts, rather than trying forever", async () =>
    {
        const connection = new Database(":memory:");
        const jobs = schedule(connection);
        const tried: number[] = [];

        let clock = 1_000_000;

        const kernel = createKernel({
            plugins: [definePlugin("holds", {
                version: "1.0.0",
                describe: "Always fails.",
                commands: {
                    "holds.release": {
                        describe: "Throws every time.",
                        schema: z.object({}),
                        run: () => { tried.push(clock); throw new Error("still broken"); },
                    },
                },
            })],
            schedule: jobs,
            now: () => clock,
            attempts: 3,
        });

        await kernel.start();

        kernel.context("holds").commands.later("holds.release", {}, 0);

        for (let turn = 0; turn < 6; turn += 1)
        {
            await kernel.due();

            clock += 120_000;
        }

        expect(tried).toHaveLength(3);
        expect(await jobs.take(clock, 10)).toEqual([]);

        await kernel.stop();
        connection.close();
    });

    test("says why a command with requires can never run on a schedule", async () =>
    {
        const connection = new Database(":memory:");

        const kernel = createKernel({
            plugins: [definePlugin("holds", {
                version: "1.0.0",
                describe: "Declares a permission a schedule cannot hold.",
                permissions: { "holds.write": { describe: "Write." } },
                commands: {
                    "holds.release": {
                        describe: "Needs a permission.",
                        requires: ["holds.write"],
                        schema: z.object({}),
                        run: () => undefined,
                    },
                },
            })],
            schedule: schedule(connection),
        });

        await kernel.start();

        const failed = await kernel.run("holds.release", {}).catch((cause: unknown) => cause) as Error;

        expect(failed.message).toMatch(/A scheduled run has no caller/);
        expect(failed.message).toMatch(/declares no requires/);

        await kernel.stop();
        connection.close();
    });

    test("refuses a command the plugin does not declare", async () =>
    {
        const connection = new Database(":memory:");
        const kernel = createKernel({ plugins: [createScheduled([])], schedule: schedule(connection) });

        await kernel.start();

        expect(() => kernel.context("holds").commands.later("other.thing", {}, 10))
            .toThrow(/does not declare/);

        await kernel.stop();
        connection.close();
    });
});
