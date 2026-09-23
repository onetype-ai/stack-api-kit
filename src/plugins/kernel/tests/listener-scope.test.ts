import { describe, expect, test } from "vitest";
import { z } from "zod";

import { migrationsOf, openStore } from "../../database/tests/openStore";
import { createKernel, definePlugin } from "../api";

import type { Plugin } from "../api";
import { column, table } from "../../database/api";

const notes = table("acting_notes", {
    id: column.text("id").primaryKey(),
    shopId: column.text("shop_id").notNull(),
    body: column.text("body").notNull(),
});

function recorder(heard: string[]): Plugin[]
{
    return [
        definePlugin("source", {
            version: "1.0.0",
            describe: "Announces.",
            emits: {
                "source.happened": {
                    describe: "Happened.",
                    schema: z.object({ shopId: z.string() }),
                },
            },
        }),
        definePlugin("keeper", {
            version: "1.0.0",
            describe: "Keeps notes for a shop.",
            tables: { notes },
            scope: { describe: "The shop.", claim: "shopId", tables: { notes: "shopId" } },
            listens: {
                "source.happened": {
                    describe: "Writes one for whoever it was about.",
                    handle: (payload, ctx) =>
                    {
                        const { shopId } = payload as { shopId: string };
                        const acting = ctx.forScope(shopId);

                        heard.push((acting.stamped("notes") as { shopId: string }).shopId);
                    },
                },
            },
        }),
    ];
}

async function startServer(): ReturnType<typeof openStore>
{
    const store = await openStore({ keeper: { notes } });

    await store.migrate([{ plugin: "keeper", from: migrationsOf("CREATE TABLE acting_notes (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, body TEXT NOT NULL)") }]);

    return store;
}

describe("a listener acting for a scope", () =>
{
    test("reaches the scope its payload named", async () =>
    {
        const store = await startServer();
        const heard: string[] = [];

        const kernel = createKernel({
            plugins: recorder(heard),
            db: store,
            ...(store.createScopeFilter !== undefined && { scopeFilter: store.createScopeFilter() }),
        });

        await kernel.start();

        kernel.context("source").events.emit("source.happened", { shopId: "acme" });

        await new Promise((done) => setImmediate(done));

        expect(heard).toEqual(["acme"]);

        await kernel.stop();
        await store.close();
    });

    test("is refused inside a request, where the caller decides the scope", async () =>
    {
        const store = await startServer();

        const kernel = createKernel({
            plugins: recorder([]),
            db: store,
            ...(store.createScopeFilter !== undefined && { scopeFilter: store.createScopeFilter() }),
        });

        await kernel.start();

        const who = { id: "u1", permissions: [], claims: { shopId: "acme" } };

        expect(() => kernel.context("keeper", who).forScope("other"))
            .toThrow(/a scope of their own/);

        await kernel.stop();
        await store.close();
    });
});
