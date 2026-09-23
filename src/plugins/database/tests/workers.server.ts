import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";

import { column, postgres, table } from "../api";
import { poolConnections } from "../internal/pgConnections";

import type { PostgresStore } from "../api";
import type { Pool } from "pg";

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

// a Postgres handle runs raw SQL; the portable type does not claim it
type Raw = { execute: (query: unknown) => Promise<unknown> };

const probes = table("probe_rows", { id: column.id().primaryKey() });

test("a transaction whose connection died leaves the pool fit for the next one", async () =>
{
    const store = await postgres({ url, poolSize: 1, tables: { probe: { probes } } });

    await expect(store.tx("probe", async (db) =>
    {
        await (db as Raw).execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
    })).rejects.toThrow();

    const answered = await store.tx("probe", async (db) => (await (db as Raw).execute(sql`SELECT 1 AS "one"`)) as unknown);

    expect(answered).toBeDefined();

    await store.close();
});

test("a connection a transaction left unfit is destroyed, never handed to the next one, and a fit one is kept", async () =>
{
    const connections = await poolConnections(url, 1);
    const pool = connections.drizzleAny() as Pool;

    await connections.hold((client) => client.query("SELECT 1"));
    const keptWhenFit = pool.idleCount;

    await connections.hold(async (client) =>
    {
        await client.query("SELECT 1");
        client.ruin?.(new Error("the ROLLBACK failed"));
    });

    expect(keptWhenFit).toBe(1);
    expect(pool.totalCount).toBe(0);

    await connections.close();
});

test("an idle connection the server dropped is logged without the address, and the process lives on", async () =>
{
    const lines: { line: string; about: unknown }[] = [];
    const record = (line: string, about?: Readonly<Record<string, unknown>>): void =>
    {
        lines.push({ line, about });
    };
    const connections = await poolConnections(url, 1, { debug: record, info: record, warn: record, error: record });
    const pool = connections.drizzleAny() as Pool;

    pool.emit("error", new Error("terminating connection due to administrator command"));
    await connections.any.query("SELECT 1");

    expect(lines.map((one) => one.line)).toEqual(["database: an idle Postgres connection failed; the pool drops it and opens another"]);
    expect(JSON.stringify(lines)).not.toContain(url);

    await connections.close();
});

test("a wrong password is refused without the password in what anyone reads", async () =>
{
    const wrong = new URL(url);
    wrong.password = "not-the-password-8f3a";
    const store = await postgres({ url: wrong.toString(), tables: {} });

    const failure = await store.migrate([]).then(() => undefined, (cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain("not-the-password-8f3a");
    expect(JSON.stringify(failure)).not.toContain("not-the-password-8f3a");

    await store.close();
});
