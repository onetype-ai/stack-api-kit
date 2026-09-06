import { describe, expect, test } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";

import { database, outbox } from "../../database/api";
import { createKernel, definePlugin } from "../api";

import type { Plugin } from "../api";

function emitter(): Plugin
{
    return definePlugin("orders", {
        version: "1.0.0",
        describe: "The orders plugin.",
        emits: { "orders.placed": { describe: "An order was placed.", schema: z.object({ id: z.string() }) } },
    });
}

function recorder(recorded: string[]): Plugin
{
    return definePlugin("ledger", {
        version: "1.0.0",
        describe: "The ledger plugin.",
        listens: {
            "orders.placed": {
                describe: "Records what was placed.",
                handle: (payload) => { recorded.push((payload as { id: string }).id); },
            },
        },
    });
}

describe("an event kept in an outbox", () =>
{
    test("outlives the process that emitted it, and reaches the next one", async () =>
    {
        const connection = new Database(":memory:");
        const unsent = outbox(connection);
        const recorded: string[] = [];

        // A process that committed the work and stopped before delivering:
        // the row is what it left behind.
        unsent.keep({}, [{ id: "a1", plugin: "orders", name: "orders.placed", payload: { id: "order-1" } }]);

        expect(await unsent.unsent()).toHaveLength(1);

        const restarted = createKernel({ plugins: [emitter(), recorder(recorded)], outbox: unsent });

        await restarted.start();

        expect(recorded).toEqual(["order-1"]);
        expect(await unsent.unsent()).toHaveLength(0);

        await restarted.stop();
        connection.close();
    });

    test("is forgotten only once a listener has recorded it", async () =>
    {
        const connection = new Database(":memory:");
        const unsent = outbox(connection);
        const store = database({ file: ":memory:", tables: { orders: {} } });

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
        expect(await unsent.unsent()).toHaveLength(1);

        released?.();
        await new Promise((done) => setImmediate(done));

        expect(await unsent.unsent()).toHaveLength(0);

        await kernel.stop();
        store.close();
        connection.close();
    });

    test("is never kept at all when the work rolled back", async () =>
    {
        const connection = new Database(":memory:");
        const unsent = outbox(connection);
        const store = database({ file: ":memory:", tables: { orders: {} } });

        const kernel = createKernel({ plugins: [emitter(), recorder([])], db: store, outbox: unsent });

        await kernel.start();

        await kernel.context("orders").tx(async (inside) =>
        {
            inside.events.emit("orders.placed", { id: "order-3" });

            throw new Error("the order was refused");
        }).catch(() => undefined);

        expect(await unsent.unsent()).toHaveLength(0);

        await kernel.stop();
        store.close();
        connection.close();
    });

    test("and never once a listener threw, so the next start tries again", async () =>
    {
        const connection = new Database(":memory:");
        const unsent = outbox(connection);
        const store = database({ file: ":memory:", tables: { orders: {} } });

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

        await new Promise((settle) => setTimeout(settle, 10));

        expect(await unsent.unsent()).toHaveLength(1);

        await kernel.stop();

        const recorded: string[] = [];
        const restarted = createKernel({ plugins: [emitter(), recorder(recorded)], outbox: unsent });

        await restarted.start();

        expect(recorded).toEqual(["order-3"]);

        await restarted.stop();
        connection.close();
    });
});
