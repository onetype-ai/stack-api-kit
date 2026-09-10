import { describe, expect, test } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";

import { schedule } from "../../database/api";
import { Refusal, createKernel, definePlugin } from "../api";

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
            beatMs: 5,
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
            beatMs: 5,
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
            mostAttempts: 3,
        });

        await kernel.start();

        kernel.context("holds").commands.later("holds.release", {}, 0);

        for (let turn = 0; turn < 6; turn += 1)
        {
            await kernel.due();

            clock += 120_000;
        }

        expect(tried).toHaveLength(3);
        expect(await jobs.claim(clock, 10)).toEqual([]);

        await kernel.stop();
        connection.close();
    });

    test("stops trying when the command refuses for good, and keeps trying when it does not", async () =>
    {
        async function attemptsFor(status: number): Promise<number>
        {
            const connection = new Database(":memory:");
            const jobs = schedule(connection);
            const tried: number[] = [];

            let clock = 1_000_000;

            const kernel = createKernel({
                plugins: [definePlugin("holds", {
                    version: "1.0.0",
                    describe: "Refuses every time.",
                    commands: {
                        "holds.release": {
                            describe: "Refuses.",
                            schema: z.object({}),
                            run: () =>
                            {
                                tried.push(clock);

                                throw new Refusal(status, "NO", "Not this one.");
                            },
                        },
                    },
                })],
                schedule: jobs,
                now: () => clock,
                mostAttempts: 4,
            });

            await kernel.start();

            kernel.context("holds").commands.later("holds.release", {}, 0);

            for (let turn = 0; turn < 8; turn += 1)
            {
                await kernel.due();

                clock += 120_000;
            }

            await kernel.stop();
            connection.close();

            return tried.length;
        }

        // A 4xx is an answer about the work, so the same answer four times
        // is four times the cost for one outcome.
        expect(await attemptsFor(400)).toBe(1);
        expect(await attemptsFor(404)).toBe(1);

        // The two 4xx that HTTP already says are about the moment, and
        // everything 5xx, which never claimed to be final.
        expect(await attemptsFor(429)).toBe(4);
        expect(await attemptsFor(408)).toBe(4);
        expect(await attemptsFor(502)).toBe(4);
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

        expect(failed.message).toMatch(/A scheduled run has no identity/);
        expect(failed.message).toMatch(/declares no requires/);

        await kernel.stop();
        connection.close();
    });

    test("names the plugin when nothing was given to schedule with", async () =>
    {
        // No schedule passed at all: the plugin reaches for one anyway.
        const kernel = createKernel({ plugins: [createScheduled([])] });

        await kernel.start();

        try
        {
            kernel.context("holds").commands.later("holds.release", { id: "a" }, 10);
            expect.unreachable();
        }
        catch (cause)
        {
            // The name is the point: this refusal stops every test that boots
            // "holds" as a dependency, in files its author never opened.
            expect((cause as Error).message).toMatch(/^"holds" used ctx\.commands\.later/);
            expect((cause as { plugin?: string }).plugin).toBe("holds");
        }

        await kernel.stop();
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

    test("what gave up is readable, so a repetition that ended is not silent", async () =>
    {
        const connection = new Database(":memory:");
        const jobs = schedule(connection);

        let clock = 1_000_000;

        const kernel = createKernel({
            plugins: [definePlugin("holds", {
                version: "1.0.0",
                describe: "Asks for itself, and always fails.",
                commands: {
                    "holds.sweep": {
                        describe: "Throws every time.",
                        schema: z.object({ round: z.number() }),
                        run: () => { throw new Error("the store was locked"); },
                    },
                },
            })],
            schedule: jobs,
            now: () => clock,
            mostAttempts: 3,
        });

        await kernel.start();

        expect(kernel.work.failed()).toEqual([]);

        kernel.context("holds").commands.later("holds.sweep", { round: 4 }, 0);

        for (let turn = 0; turn < 6; turn += 1)
        {
            await kernel.due();

            clock += 120_000;
        }

        const dead = kernel.work.failed();

        expect(dead).toHaveLength(1);
        expect(dead[0]?.plugin).toBe("holds");
        expect(dead[0]?.command).toBe("holds.sweep");
        expect(dead[0]?.attempts).toBe(3);
        expect(dead[0]?.input).toEqual({ round: 4 });
        expect((dead[0]?.error as Error).message).toBe("the store was locked");

        await kernel.stop();
        connection.close();
    });
});
