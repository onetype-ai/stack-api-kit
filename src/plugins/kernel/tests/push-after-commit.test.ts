import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import { openStore } from "../../database/tests/openStore";

import type { ChannelMessage } from "../api";

const board = definePlugin("board", {
    version: "1.0.0",
    describe: "Pushes what changed on the board.",
    channels: { "board.changed": { describe: "The board changed.", schema: z.object({ id: z.string() }), reach: "everyone" } },
});

async function started()
{
    const store = await openStore({ board: {} });
    const sent: { message: unknown; whileOpen: boolean }[] = [];
    const kernel = createKernel({
        plugins: [board],
        db: store,
        // what a socket server does with a push, and whether the work it announces was still uncommitted then
        sockets: { push: (sending: ChannelMessage) => sent.push({ message: sending.message, whileOpen: store.inTransaction() }) },
    });

    await kernel.start();

    return { kernel, store, sent };
}

describe("a push inside a transaction", () =>
{
    test("is sent once the transaction commits, never while it is open", async () =>
    {
        const { kernel, store, sent } = await started();

        await kernel.context("board").tx(async (inside) =>
        {
            inside.push("board.changed", { id: "card-1" });

            expect(sent).toEqual([]);
        });

        expect(sent).toEqual([{ message: { id: "card-1" }, whileOpen: false }]);
        await kernel.stop();
        await store.close();
    });

    test("is never sent when the transaction rolls back", async () =>
    {
        const { kernel, store, sent } = await started();

        const failed = kernel.context("board").tx(async (inside) =>
        {
            inside.push("board.changed", { id: "card-1" });

            throw new Error("the work failed");
        });

        await expect(failed).rejects.toThrow("the work failed");
        expect(sent).toEqual([]);
        await kernel.stop();
        await store.close();
    });

    test("waits for the outermost transaction, and goes with its rollback", async () =>
    {
        const { kernel, store, sent } = await started();

        const failed = kernel.context("board").tx(async (outer) =>
        {
            await outer.tx(async (inner) =>
            {
                inner.push("board.changed", { id: "card-1" });
            });

            expect(sent).toEqual([]);

            throw new Error("the outer work failed");
        });

        await expect(failed).rejects.toThrow("the outer work failed");
        expect(sent).toEqual([]);
        await kernel.stop();
        await store.close();
    });

    test("outside a transaction is sent at once", async () =>
    {
        const { kernel, store, sent } = await started();

        kernel.context("board").push("board.changed", { id: "card-1" });

        expect(sent).toEqual([{ message: { id: "card-1" }, whileOpen: false }]);
        await kernel.stop();
        await store.close();
    });
});
