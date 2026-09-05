import { describe, expect, test } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { database } from "../../database/api";
import { createKernel, definePlugin } from "../api";

import type { Plugin } from "../api";

const notes = sqliteTable("acting_notes", {
    id: text("id").primaryKey(),
    shopId: text("shop_id").notNull(),
    body: text("body").notNull(),
});

function recorder(recorded: string[]): Plugin[]
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

                        recorded.push((acting.stamped("notes") as { shopId: string }).shopId);
                    },
                },
            },
        }),
    ];
}

function startServer()
{
    const store = database({ file: ":memory:", tables: { keeper: { notes } } });

    store.of("keeper").$client.exec(
        "CREATE TABLE acting_notes (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, body TEXT NOT NULL)",
    );

    return store;
}

describe("a listener acting for a scope", () =>
{
    test("reaches the scope its payload named", async () =>
    {
        const store = startServer();
        const recorded: string[] = [];

        const kernel = createKernel({
            plugins: recorder(recorded),
            db: store,
            ...(store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        });

        await kernel.start();

        kernel.context("source").events.emit("source.happened", { shopId: "acme" });

        await new Promise((keep) => setImmediate(keep));

        expect(recorded).toEqual(["acme"]);

        await kernel.stop();
        store.close();
    });

    test("is refused inside a request, where the caller decides the scope", async () =>
    {
        const store = startServer();

        const kernel = createKernel({
            plugins: recorder([]),
            db: store,
            ...(store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        });

        await kernel.start();

        const who = { id: "u1", permissions: [], claims: { shopId: "acme" } };

        expect(() => kernel.context("keeper", who).forScope("other"))
            .toThrow(/forScope inside a request/);

        await kernel.stop();
        store.close();
    });
});
