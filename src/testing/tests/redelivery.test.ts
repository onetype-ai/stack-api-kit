import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { definePlugin, outbox, start } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { StartedApp } from "../../index";
import type { TestKernel } from "../startTestKernel";


const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SECRET_NOTE = "note-that-must-not-be-logged";
const EVENT = "orders.order.placed";

const heardBy = { mailer: 0, ledger: 0 };
let ledgerRefusals = 0;
let ledgerDelayMs = 0;
let ledgerHangs = 0;

// A table, so a transaction on a real database has something to hold.
const notes = sqliteTable("desk_notes", { id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull() });

const orders = definePlugin("orders", {
    version: "1.0.0",
    describe: "Announces an order.",
    tables: { deskNotes: notes },
    migrations: "./src/testing/tests/fixtures/desk/migrations",
    // the claim is not the payload's field name: the log finds the tenant by the scope's own column name
    scope: { describe: "A workspace's orders.", claim: "workspace", tables: { deskNotes: "workspaceId" } },
    emits: { [EVENT]: { describe: "An order was placed.", schema: z.object({ id: z.string(), workspaceId: z.string(), note: z.string() }) } },
});

const mailer = definePlugin("mailer", {
    version: "1.0.0",
    describe: "Mails a receipt, and never fails.",
    dependsOn: ["orders"],
    listens: {
        [EVENT]: {
            describe: "Counts a receipt.",
            handle: () =>
            {
                heardBy.mailer += 1;
            },
        },
    },
});

const ledger = definePlugin("ledger", {
    version: "1.0.0",
    describe: "Books the order, refusing as often as the test says.",
    dependsOn: ["orders"],
    listens: {
        [EVENT]: {
            describe: "Books it, or throws while the ledger is not ready.",
            handle: async () =>
            {
                if (ledgerHangs > 0)
                {
                    ledgerHangs -= 1;
                    await new Promise(() => undefined);
                }

                await new Promise((resolve) => setTimeout(resolve, ledgerDelayMs));

                if (ledgerRefusals > 0)
                {
                    ledgerRefusals -= 1;
                    throw new Error("The ledger is not ready yet.");
                }

                heardBy.ledger += 1;
            },
        },
    },
});

let time = 0;
let api: TestKernel | undefined;
let apps: StartedApp[] = [];
let folder: string | undefined;

beforeEach(() =>
{
    time = Date.now();
    heardBy.mailer = 0;
    heardBy.ledger = 0;
    ledgerRefusals = 0;
    ledgerDelayMs = 0;
    ledgerHangs = 0;
});

afterEach(async () =>
{
    await api?.stop();
    api = undefined;

    for (const app of apps.splice(0))
    {
        await app.stop();
    }

    apps = [];

    if (folder !== undefined)
    {
        rmSync(folder, { recursive: true, force: true });
        folder = undefined;
    }
});

const boot = async (): Promise<TestKernel> =>
{
    api = await startTestKernel({ plugins: [orders, mailer, ledger], now: () => time, outbox: true });

    return api;
};

const place = async (kernel: TestKernel): Promise<void> =>
{
    await kernel.kernel.context("orders").tx((ctx) =>
    {
        ctx.events.emit(EVENT, { id: "order-1", workspaceId: WORKSPACE, note: SECRET_NOTE });

        return Promise.resolve();
    });

    // Delivery after commit is not awaited by the caller; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
};

const later = (seconds: number): void =>
{
    time += seconds * 1_000;
};

// Waits for what a timer or another side brings about, however long a busy machine takes, rather than a fixed margin.
async function until(isMet: () => boolean, limitMs = 10_000): Promise<void>
{
    const end = Date.now() + limitMs;

    while (!isMet() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("an event one listener refused", () =>
{
    test("reaches that listener once its backoff is over, without calling the one that already heard it", async () =>
    {
        const kernel = await boot();
        ledgerRefusals = 1;

        await place(kernel);
        const tooSoon = await kernel.kernel.redeliver();
        later(2);
        const handed = await kernel.kernel.redeliver();
        const afterwards = await kernel.kernel.redeliver();

        expect(tooSoon).toBe(0);
        expect(handed).toBe(1);
        expect(afterwards).toBe(0);
        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    });

    test("waits longer after each refusal", async () =>
    {
        const kernel = await boot();
        ledgerRefusals = 2;

        await place(kernel);
        later(2);
        await kernel.kernel.redeliver();
        later(2);
        const beforeTheSecondBackoff = await kernel.kernel.redeliver();
        later(2);
        const afterIt = await kernel.kernel.redeliver();

        expect(beforeTheSecondBackoff).toBe(0);
        expect(afterIt).toBe(1);
        expect(heardBy.ledger).toBe(1);
    });
});

describe("an event a listener keeps refusing", () =>
{
    const exhaust = async (kernel: TestKernel): Promise<void> =>
    {
        for (let round = 0; round < 10; round += 1)
        {
            later(300);
            await kernel.kernel.redeliver();
        }
    };

    test("is kept as a dead letter, logged at error once with its workspace and never its payload", async () =>
    {
        const kernel = await boot();
        ledgerRefusals = 1_000;

        await place(kernel);
        await exhaust(kernel);
        const failed = await kernel.kernel.work.failedEvents();
        const givenUp = kernel.logLines.filter((line) => line.level === "error" && line.line.includes("given up"));

        expect(failed).toEqual([expect.objectContaining({ plugin: "orders", name: EVENT, heard: expect.arrayContaining(["mailer"]) as unknown, attempts: 8 })]);
        expect(failed[0]?.heard).not.toContain("ledger");
        expect(givenUp).toHaveLength(1);
        expect(givenUp[0]).toMatchObject({ event: EVENT, listeners: ["ledger"], workspaceId: WORKSPACE });
        expect(JSON.stringify(kernel.logLines)).not.toContain(SECRET_NOTE);
        expect(heardBy.mailer).toBe(1);
    });

    test("is delivered again by an operator, to the listener that never heard it", async () =>
    {
        const kernel = await boot();
        ledgerRefusals = 1_000;
        await place(kernel);
        await exhaust(kernel);
        const [dead] = await kernel.kernel.work.failedEvents();
        ledgerRefusals = 0;

        const revived = await kernel.kernel.work.retryFailed(dead!.id);
        const unknown = await kernel.kernel.work.retryFailed("no-such-event");
        await kernel.kernel.redeliver();

        expect(revived).toBe(true);
        expect(unknown).toBe(false);
        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
        expect(await kernel.kernel.work.failedEvents()).toEqual([]);
    });
});

describe("an event whose delivery never finished", () =>
{
    test("is handed out after a grace period, in the running process", async () =>
    {
        const kernel = await boot();
        const kept = outboxOf(kernel);
        kept.save(undefined, [{ id: crypto.randomUUID(), plugin: "orders", name: EVENT, payload: { id: "order-2", workspaceId: WORKSPACE, note: "x" } }]);

        later(5);
        const withinGrace = await kernel.kernel.redeliver();
        later(56);
        const afterGrace = await kernel.kernel.redeliver();

        expect(withinGrace).toBe(0);
        expect(afterGrace).toBe(1);
        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    });
});

// The same store the test kernel keeps its events in.
const outboxOf = (kernel: TestKernel): ReturnType<typeof outbox> =>
{
    const store = kernel.store as unknown as { outbox?: () => ReturnType<typeof outbox> };

    return store.outbox!();
};

describe("a listener slower than the outbox lease", () =>
{
    test("is not handed the event a second time while the writing process still delivers it", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const running = await start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, outboxLeaseMs: 1_000, sockets: false });
        apps = [running];
        ledgerDelayMs = 2_500;

        await running.kernel.context("orders").tx((ctx) =>
        {
            ctx.events.emit(EVENT, { id: "order-5", workspaceId: WORKSPACE, note: "x" });

            return Promise.resolve();
        });
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        const handedAgain = await running.kernel.redeliver();
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        expect(handedAgain).toBe(0);
        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    }, 10_000);
});

describe("a process that dies mid-delivery", () =>
{
    test("leaves the next one to call only the listeners that had not finished", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const dying = await start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, outboxLeaseMs: 1_000, sockets: false });
        ledgerHangs = 1;

        await dying.kernel.context("orders").tx((ctx) =>
        {
            ctx.events.emit(EVENT, { id: "order-6", workspaceId: WORKSPACE, note: "x" });

            return Promise.resolve();
        });
        await until(() => heardBy.mailer === 1);
        await dying.stop();
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        apps = [await start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, outboxLeaseMs: 1_000, sockets: false })];

        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    }, 10_000);
});

describe("a listener whose hearing cannot be kept", () =>
{
    test("is logged at warn while the kernel runs, naming the event and listener but not the payload", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const lines: { level: string; line: string; about: Readonly<Record<string, unknown>> | undefined }[] = [];
        const record = (level: string) => (line: string, about?: Readonly<Record<string, unknown>>): void =>
        {
            lines.push({ level, line, about });
        };
        const running = await start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, sockets: false, log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } });
        apps = [running];
        const connection = new Database(file);
        connection.exec("CREATE TRIGGER refuse_heard BEFORE UPDATE OF heard ON kit_outbox BEGIN SELECT RAISE(ABORT, 'no room left'); END;");
        connection.close();
        ledgerDelayMs = 50;

        await running.kernel.context("orders").tx((ctx) =>
        {
            ctx.events.emit(EVENT, { id: "order-7", workspaceId: WORKSPACE, note: SECRET_NOTE });

            return Promise.resolve();
        });
        await until(() => heardBy.ledger === 1 && lines.some((line) => line.line.includes("could not keep that a listener heard")));
        const warned = lines.filter((line) => line.level === "warn" && line.line.includes("could not keep that a listener heard"));

        expect(warned.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(warned)).toContain(EVENT);
        expect(JSON.stringify(lines)).not.toContain(SECRET_NOTE);
        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    }, 10_000);
});

describe("two processes on one database", () =>
{
    test("deliver a due event exactly once between them", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const connection = new Database(file);
        outbox(connection).save(undefined, [{ id: crypto.randomUUID(), plugin: "orders", name: EVENT, payload: { id: "order-3", workspaceId: WORKSPACE, note: "x" } }]);
        connection.close();

        apps = await Promise.all([1, 2].map(() => start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, sockets: false })));

        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    });

    test("reads an outbox table from before retries, and delivers what it kept", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const connection = new Database(file);
        connection.exec("CREATE TABLE kit_outbox (id TEXT PRIMARY KEY, plugin TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, writtenAt TEXT NOT NULL)");
        connection.prepare("INSERT INTO kit_outbox VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), "orders", EVENT, JSON.stringify({ id: "order-4", workspaceId: WORKSPACE, note: "x" }), new Date().toISOString());
        connection.close();

        apps = [await start({ plugins: [orders, mailer, ledger], database: { file }, outbox: true, sockets: false })];

        expect(heardBy).toEqual({ mailer: 1, ledger: 1 });
    });
});
