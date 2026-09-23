import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, outbox, start } from "../../index";
import { column, table } from "../../tables";

import type { StartedApp } from "../../index";


const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SECRET_NOTE = "note-that-must-not-be-logged";
const EVENT = "orders.order.placed";

const heardBy = { mailer: 0, ledger: 0 };
let ledgerRefusals = 0;
let ledgerDelayMs = 0;
let ledgerHangs = 0;

// A table, so a transaction on a real database has something to hold.
const notes = table("desk_notes", { id: column.id().primaryKey(), workspaceId: column.text("workspace_id").notNull() });

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

let apps: StartedApp[] = [];
let folder: string | undefined;

beforeEach(() =>
{
    heardBy.mailer = 0;
    heardBy.ledger = 0;
    ledgerRefusals = 0;
    ledgerDelayMs = 0;
    ledgerHangs = 0;
});

afterEach(async () =>
{

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




// Waits for what a timer or another side brings about, however long a busy machine takes, rather than a fixed margin.
async function until(isMet: () => boolean, limitMs = 10_000): Promise<void>
{
    const end = Date.now() + limitMs;

    while (!isMet() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// What only SQLite's own file shows about redelivery: a trigger written in its dialect, a table an 8.x release left,
// and two processes sharing one file. Two processes on Postgres are proven against a server (`pnpm test:pg`).
describe("a listener whose hearing cannot be kept, on SQLite", () =>
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

describe("two processes on one SQLite file", () =>
{
    test("deliver a due event exactly once between them", async () =>
    {
        folder = mkdtempSync(join(tmpdir(), "kit-redelivery-"));
        const file = join(folder, "app.db");
        const connection = new Database(file);
        await outbox(connection).save(undefined, [{ id: crypto.randomUUID(), plugin: "orders", name: EVENT, payload: { id: "order-3", workspaceId: WORKSPACE, note: "x" } }]);
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
