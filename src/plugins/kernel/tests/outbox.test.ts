import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

import type { Outbox, Plugin } from "../api";
import type { PortableDb } from "../../database/api";
import { column, table } from "../../database/api";
import { migrationsOf, openStore } from "../../database/tests/openStore";

function emitter(): Plugin
{
    return definePlugin("orders", {
        version: "1.0.0",
        describe: "The orders plugin.",
        emits: { "orders.placed": { describe: "An order was placed.", schema: z.object({ id: z.string() }) } },
    });
}

function recorder(heard: string[]): Plugin
{
    return definePlugin("ledger", {
        version: "1.0.0",
        describe: "The ledger plugin.",
        listens: {
            "orders.placed": {
                describe: "Records what was placed.",
                handle: (payload) => { heard.push((payload as { id: string }).id); },
            },
        },
    });
}

describe("an event kept in an outbox", () =>
{
    test("reaches the next process even when it starts in the same millisecond the row was written", async () =>
    {
        const store = await openStore({ orders: {} });
        const unsent = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");
        const heard: string[] = [];
        const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2030, 0, 1));

        try
        {
            await unsent.save({}, [{ id: "a1", plugin: "orders", name: "orders.placed", payload: { id: "order-1" } }]);
            const restarted = createKernel({ plugins: [emitter(), recorder(heard)], outbox: unsent });

            await restarted.start();

            expect(heard).toEqual(["order-1"]);
            await restarted.stop();
        }
        finally
        {
            frozen.mockRestore();
            await store.close();
        }
    });

    test("outlives the process that emitted it, and reaches the next one", async () =>
    {
        const store = await openStore({ orders: {} });
        const unsent = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");
        const heard: string[] = [];

        // A process that committed the work and stopped before delivering: the row is what it left behind.
        await unsent.save({}, [{ id: "a1", plugin: "orders", name: "orders.placed", payload: { id: "order-1" } }]);

        expect(await unsent.pending()).toHaveLength(1);

        const restarted = createKernel({ plugins: [emitter(), recorder(heard)], outbox: unsent });

        await restarted.start();

        expect(heard).toEqual(["order-1"]);
        expect(await unsent.pending()).toHaveLength(0);

        await restarted.stop();
        await store.close();
    });

    test("is forgotten only once a listener has heard it", async () =>
    {
        const store = await openStore({ orders: {} });
        const unsent = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");

        let released: (() => void) | undefined;
        const slow = new Promise<void>((done) => { released = done; });

        const kernel = createKernel({
            plugins: [
                emitter(),
                definePlugin("ledger", {
                    version: "1.0.0",
                    describe: "The ledger plugin.",
                    listens: {
                        "orders.placed": { describe: "Takes its time.", handle: () => slow },
                    },
                }),
            ],
            db: store,
            outbox: unsent,
        });

        await kernel.start();

        await kernel.context("orders").tx(async (inside) =>
        {
            inside.events.emit("orders.placed", { id: "order-2" });
        });

        // The listener has not finished, so the event is still owed.
        expect(await unsent.pending()).toHaveLength(1);

        released?.();
        await new Promise((done) => setImmediate(done));

        expect(await unsent.pending()).toHaveLength(0);

        await kernel.stop();
        await store.close();
    });

    test("is never kept at all when the work rolled back", async () =>
    {
        const store = await openStore({ orders: {} });
        const unsent = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");

        const kernel = createKernel({ plugins: [emitter(), recorder([])], db: store, outbox: unsent });

        await kernel.start();

        await kernel.context("orders").tx(async (inside) =>
        {
            inside.events.emit("orders.placed", { id: "order-3" });

            throw new Error("the order was refused");
        }).catch(() => undefined);

        expect(await unsent.pending()).toHaveLength(0);

        await kernel.stop();
        await store.close();
    });

    test("takes the work down with it when it cannot be kept, so neither exists without the other", async () =>
    {
        const rows = table("orders_rows", { id: column.text("id").primaryKey() });
        const store = await openStore({ orders: { rows } });
        const db = store.forPlugin("orders") as PortableDb;
        const refusing: Outbox = { save: () => Promise.reject(new Error("the outbox could not be written")), markSent: () => Promise.resolve(), pending: () => Promise.resolve([]) };
        const orders = definePlugin("orders", {
            version: "1.0.0",
            describe: "The orders plugin, with a table.",
            tables: { rows },
            emits: { "orders.placed": { describe: "An order was placed.", schema: z.object({ id: z.string() }) } },
        });

        await store.migrate([{ plugin: "orders", from: migrationsOf("CREATE TABLE orders_rows (id TEXT PRIMARY KEY)") }]);

        const kernel = createKernel({ plugins: [orders], db: store, outbox: refusing });

        await kernel.start();

        await expect(kernel.context("orders").tx(async (inside) =>
        {
            await (inside.db as PortableDb).insert(rows).values({ id: "order-5" });
            inside.events.emit("orders.placed", { id: "order-5" });
        })).rejects.toThrow("the outbox could not be written");

        expect(await db.select().from(rows)).toEqual([]);

        await kernel.stop();
        await store.close();
    });

    test("stays delivered when another transaction, open while it was delivered, rolls back", async () =>
    {
        const rows = table("orders_rows", { id: column.text("id").primaryKey() });
        const store = await openStore({ orders: { rows }, ledger: { rows } });
        const kept: Outbox = store.outbox?.() ?? expect.unreachable("a SQLite store keeps an outbox");
        let release: () => void = () => undefined;
        const listening = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const slowLedger = definePlugin("ledger", {
            version: "1.0.0",
            describe: "Hears the order, slowly.",
            tables: { rows },
            listens: {
                "orders.placed": {
                    describe: "Takes a while to record it.",
                    handle: async () =>
                    {
                        release();
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    },
                },
            },
        });

        const kernel = createKernel({ plugins: [emitter(), slowLedger], db: store, outbox: kept });

        await kernel.start();

        await kernel.context("orders").tx((inside) =>
        {
            inside.events.emit("orders.placed", { id: "order-6" });

            return Promise.resolve();
        });
        await listening;

        // opened while the delivery runs, and still open when it marks the event sent
        await kernel.context("ledger").tx(async () =>
        {
            await new Promise((resolve) => setTimeout(resolve, 100));

            throw new Error("the other work failed");
        }).catch(() => undefined);
        await kernel.settled();

        expect(await kept.pending()).toEqual([]);

        await kernel.stop();
        await store.close();
    });

    test("and never once a listener threw, so the next start tries again", async () =>
    {
        const store = await openStore({ orders: {} });
        const unsent = store.outbox?.() ?? expect.unreachable("a store keeps an outbox");

        const broken = definePlugin("ledger", {
            version: "1.0.0",
            describe: "The ledger plugin.",
            listens: {
                "orders.placed": {
                    describe: "Cannot record anything.",
                    handle: () => { throw new Error("the ledger is down"); },
                },
            },
        });

        const kernel = createKernel({ plugins: [emitter(), broken], db: store, outbox: unsent });

        await kernel.start();

        await kernel.context("orders").tx(async (inside) =>
        {
            inside.events.emit("orders.placed", { id: "order-3" });
        });

        await new Promise((flush) => setTimeout(flush, 10));

        expect(await unsent.pending()).toHaveLength(1);

        await kernel.stop();

        const heard: string[] = [];
        const restarted = createKernel({ plugins: [emitter(), recorder(heard)], outbox: unsent });

        await restarted.start();

        expect(heard).toEqual(["order-3"]);

        await restarted.stop();
        await store.close();
    });
});
