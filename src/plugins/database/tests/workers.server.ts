import { afterEach, beforeEach, expect, test } from "vitest";

import { postgres } from "../api";

import type { PostgresStore } from "../api";

// Two processes' worth of connections against one server: what a claim must survive, and PGlite cannot show.
const url = process.env["KIT_PG_URL"];

if (url === undefined || url === "")
{
    throw new Error("KIT_PG_URL is not set, so there is no Postgres server to test against. Run infra/remote-verify.sh --with-pg --lane kit <kit> \"pnpm test:pg\".");
}

let workerA: PostgresStore;
let workerB: PostgresStore;

beforeEach(async () =>
{
    workerA = await postgres({ url, tables: {} });
    workerB = await postgres({ url, tables: {} });

    await Promise.all([workerA.migrate([]), workerB.migrate([])]);
});

afterEach(async () =>
{
    await workerA.close();
    await workerB.close();
});

const JOBS = 200;

test("two workers claiming at once take every job exactly once", async () =>
{
    const scheduleA = workerA.schedule();
    const scheduleB = workerB.schedule();
    const now = Date.now();
    const run = crypto.randomUUID();

    for (let job = 0; job < JOBS; job += 1)
    {
        await scheduleA.save(undefined, { id: `${run}-${String(job)}`, plugin: "items", command: "items.run", input: {}, at: now - 1_000, attempts: 0 });
    }

    const taken: string[] = [];

    const drain = async (worker: typeof scheduleA): Promise<void> =>
    {
        for (;;)
        {
            const claimed = await worker.claim(now, 7);

            if (claimed.length === 0)
            {
                return;
            }

            taken.push(...claimed.map((job) => job.id).filter((id) => id.startsWith(run)));
        }
    };

    await Promise.all([drain(scheduleA), drain(scheduleB), drain(scheduleA), drain(scheduleB)]);

    expect(new Set(taken).size).toBe(taken.length);
    expect(taken).toHaveLength(JOBS);
});

test("two workers claiming events at once take every one exactly once", async () =>
{
    const outboxA = workerA.outbox();
    const outboxB = workerB.outbox({ leaseMs: 1_000 });
    const run = crypto.randomUUID();

    await outboxA.save(undefined, Array.from({ length: JOBS }, (_unused, index) => ({ id: `${run}-${String(index)}`, plugin: "items", name: "items.made", payload: { index } })));

    // written rows are held by the process that wrote them for its lease; past it, both may claim
    const later = Date.now() + 120_000;
    const taken: string[] = [];

    const drain = async (outbox: typeof outboxA): Promise<void> =>
    {
        for (;;)
        {
            const claimed = await outbox.claim?.(later, 7) ?? [];

            if (claimed.length === 0)
            {
                return;
            }

            taken.push(...claimed.map((event) => event.id).filter((id) => id.startsWith(run)));
        }
    };

    await Promise.all([drain(outboxA), drain(outboxB), drain(outboxA), drain(outboxB)]);

    expect(new Set(taken).size).toBe(taken.length);
    expect(taken).toHaveLength(JOBS);
});
