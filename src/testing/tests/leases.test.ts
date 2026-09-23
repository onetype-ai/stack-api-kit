import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { defineCommand, definePlugin, schedule, start } from "../../index";

import type { Logger, Schedule, StartedApp } from "../../index";


type Line = { level: string; line: string; about: Readonly<Record<string, unknown>> | undefined };

const LEASE_MS = 1_000;
const PAYLOAD = "payload-that-must-not-be-logged";

const ran: string[] = [];
let slowMs = 0;

const worker = definePlugin("worker", {
    version: "1.0.0",
    describe: "A plugin with one scheduled command.",
    commands: {
        "worker.run": defineCommand()({
            describe: "Records that it ran, after taking as long as the test says.",
            schema: z.object({ note: z.string() }),
            run: async (input) =>
            {
                await new Promise((resolve) => setTimeout(resolve, slowMs));
                ran.push(input.note);
            },
        }),
    },
});

let folder: string;
let file: string;
let lines: Line[];
let log: Logger;
let api: StartedApp | undefined;
const connections: Database.Database[] = [];

beforeEach(() =>
{
    folder = mkdtempSync(join(tmpdir(), "kit-jobs-"));
    file = join(folder, "app.db");
    lines = [];
    ran.length = 0;
    slowMs = 0;

    const record = (level: string) => (line: string, about?: Readonly<Record<string, unknown>>): void =>
    {
        lines.push({ level, line, about });
    };

    log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
});

afterEach(async () =>
{
    await api?.stop();
    api = undefined;

    for (const connection of connections.splice(0))
    {
        connection.close();
    }

    rmSync(folder, { recursive: true, force: true });
});

// Another process on the same database: its own connection and its own lease holder.
const otherProcess = (): Schedule =>
{
    const connection = new Database(file);
    connections.push(connection);

    return schedule(connection, { leaseMs: LEASE_MS });
};

const queue = async (jobs: Schedule, attempts = 0): Promise<string> =>
{
    const id = crypto.randomUUID();

    await jobs.save(undefined, { id, plugin: "worker", command: "worker.run", input: { note: PAYLOAD }, at: Date.now() - 60_000, attempts });

    return id;
};

const boot = async (scheduling: true | "enqueue" = true, jobRunMs?: number): Promise<StartedApp> =>
{
    api = await start({ plugins: [worker], database: { file }, schedule: scheduling, jobLeaseMs: LEASE_MS, ...(jobRunMs !== undefined && { jobRunMs }), sockets: false, log });

    return api;
};

const rowsOf = (): number =>
{
    const connection = new Database(file, { readonly: true });

    try
    {
        return (connection.prepare("SELECT COUNT(*) AS count FROM kit_schedule").get() as { count: number }).count;
    }
    finally
    {
        connection.close();
    }
};

// Waits for a condition a timer brings about, as long as a busy machine needs, rather than a fixed margin.
const within = async <Value>(limitMs: number, isMet: () => boolean, read: () => Value): Promise<Value> =>
{
    const until = Date.now() + limitMs;

    while (!isMet() && Date.now() < until)
    {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return read();
};

// A claim taken over, by this process or another, counts a lost run.
const lostRunsOf = (): number =>
{
    const connection = new Database(file, { readonly: true });

    try
    {
        return (connection.prepare("SELECT MAX(attempts) AS attempts FROM kit_schedule").get() as { attempts: number }).attempts;
    }
    finally
    {
        connection.close();
    }
};

describe("a job claimed by a process that stopped", () =>
{
    test("runs once its lease has run out, in the process still beating", async () =>
    {
        const dead = otherProcess();
        await queue(dead);
        await dead.claim(Date.now() - 2 * LEASE_MS, 10);

        const running = await boot();
        await running.kernel.due();

        expect(ran).toEqual([PAYLOAD]);
        expect(rowsOf()).toBe(0);
    });

    test("is left alone while its lease holds", async () =>
    {
        const alive = otherProcess();
        await queue(alive);
        await alive.claim(Date.now(), 10);

        const running = await boot();
        await running.kernel.due();

        expect(ran).toEqual([]);
        expect(rowsOf()).toBe(1);
    });

    test("is given up once its lost runs reach the limit, logged without its input", async () =>
    {
        const dead = otherProcess();
        await queue(dead, 7);
        await dead.claim(Date.now() - 2 * LEASE_MS, 10);

        const running = await boot();
        await running.kernel.due();

        expect(ran).toEqual([]);
        expect(rowsOf()).toBe(0);
        expect(lines.some((line) => line.line.includes("gave up"))).toBe(true);
        expect(JSON.stringify(lines)).not.toContain(PAYLOAD);
    });
});

describe("a job running longer than its lease", () =>
{
    test("stays with the process running it, which renews the lease as it goes", async () =>
    {
        slowMs = 2 * LEASE_MS;
        const running = await boot();
        await queue(otherProcess());

        const working = running.kernel.due();
        await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 400));
        const lostRuns = lostRunsOf();
        const stolen = await otherProcess().claim(Date.now(), 10);
        await working;

        expect(lostRuns).toBe(0);
        expect(stolen).toEqual([]);
        expect(ran).toEqual([PAYLOAD]);
    }, 10_000);

    test("cannot be finished by a process whose lease was taken over", async () =>
    {
        const slow = otherProcess();
        const id = await queue(slow);
        await slow.claim(Date.now() - 2 * LEASE_MS, 10);
        const [taken] = await otherProcess().claim(Date.now(), 10);

        await slow.markDone(id);
        await slow.markFailed(id, Date.now());

        expect(taken?.id).toBe(id);
        expect(rowsOf()).toBe(1);
    });
});

describe("a command that never settles", () =>
{
    test("stops being held after its run time, so it is taken again and the lost run counts", async () =>
    {
        slowMs = 60_000;
        const running = await boot(true, LEASE_MS);
        await queue(otherProcess());

        void running.kernel.due();
        const lostRuns = await within(8_000, () => lostRunsOf() >= 1, lostRunsOf);

        expect(lostRuns).toBeGreaterThanOrEqual(1);
        expect(lines.some((line) => line.level === "error" && line.line.includes("ran past its time"))).toBe(true);
    }, 15_000);
});

describe("a run whose lease another run took", () =>
{
    test("stops renewing and says its outcome will not count", async () =>
    {
        slowMs = 2 * LEASE_MS;
        const running = await boot();
        await queue(otherProcess());

        const working = running.kernel.due();
        const taken = (): boolean =>
        {
            const reading = new Database(file);
            const row = reading.prepare("SELECT takenAt FROM kit_schedule").get() as { takenAt: number | null } | undefined;

            reading.close();

            return row?.takenAt !== null && row?.takenAt !== undefined;
        };

        await within(10_000, taken, () => undefined);
        const connection = new Database(file);
        connection.prepare("UPDATE kit_schedule SET takenBy = 'another-run'").run();
        connection.close();
        await working;

        expect(lines.some((line) => line.level === "warn" && line.line.includes("lost its lease"))).toBe(true);
        expect(rowsOf()).toBe(1);
    }, 10_000);
});

describe("a process that only enqueues", () =>
{
    test("stores what a plugin schedules and runs none of it", async () =>
    {
        const enqueuing = await boot("enqueue");

        await enqueuing.kernel.context("worker").tx((inside) =>
        {
            inside.commands.later("worker.run", { note: "later" }, 0);

            return Promise.resolve();
        });
        const handled = await enqueuing.kernel.due();

        expect(handled).toBe(0);
        expect(ran).toEqual([]);
        expect(rowsOf()).toBe(1);
    });

    test("is refused a schedule value it does not know, naming the three it does", async () =>
    {
        await expect(start({ plugins: [worker], database: { file }, schedule: "sometimes" as "enqueue", sockets: false, log })).rejects.toThrow("true, \"enqueue\" or false");
    });

    test.each([0, 999, 3_600_001, 1.5])("is refused a lease of %s ms, naming the range", async (leaseMs) =>
    {
        await expect(start({ plugins: [worker], database: { file }, schedule: true, jobLeaseMs: leaseMs, sockets: false, log })).rejects.toThrow("from 1000 to 3600000");
    });
});

describe("a schedule table from before leases", () =>
{
    test("gains the holder column and keeps its rows claimable", async () =>
    {
        const connection = new Database(file);
        connection.exec(`
            CREATE TABLE kit_schedule (id TEXT PRIMARY KEY, plugin TEXT NOT NULL, command TEXT NOT NULL, input TEXT NOT NULL,
                runAt INTEGER NOT NULL, takenAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
        `);
        connection.prepare("INSERT INTO kit_schedule (id, plugin, command, input, runAt, attempts) VALUES (?, ?, ?, ?, ?, 0)")
            .run(crypto.randomUUID(), "worker", "worker.run", JSON.stringify({ note: "old" }), Date.now() - 1_000);
        connection.close();

        const running = await boot();
        await running.kernel.due();

        expect(ran).toEqual(["old"]);
    });
});
