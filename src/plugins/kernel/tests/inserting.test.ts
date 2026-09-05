import { expect, test } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { database } from "../../database/api";
import { createKernel, definePlugin } from "../api";

const notes = sqliteTable("billing_notes", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    body: text("body").notNull(),
});

test("a write carries the caller's scope, not the one it asked for", async () =>
{
    const store = database({ file: ":memory:", tables: { billing: { notes } } });

    store.of("billing").$client.exec(
        "CREATE TABLE billing_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, body TEXT NOT NULL)",
    );

    const kernel = createKernel({
        plugins: [definePlugin("billing", {
            version: "1.0.0",
            describe: "Notes.",
            tables: { notes },
            scope: { describe: "The account.", claim: "tenantId", tables: { notes: "tenantId" } },
            services: (ctx) => ({
                plant: async (): Promise<void> =>
                {
                    // A caller in "acme" trying to write a row for "other".
                    // What the caller asked for is overwritten by the stamp.
                    await (ctx.db as { insert: Function })
                        .insert(notes)
                        .values({ id: "x", tenantId: "other", body: "planted", ...ctx.stamped("notes") });
                },
            }),
        })],
        db: store,
        ...(store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
    });

    await kernel.start();

    const mine = kernel.context("billing", { id: "u1", permissions: [], claims: { tenantId: "acme" } });

    await (mine.services as { plant: () => Promise<void> }).plant();

    const rows = store.of("billing").$client.prepare("SELECT tenant_id FROM billing_notes").all();

        await kernel.stop();
    store.close();

    expect(rows).toEqual([{ tenant_id: "acme" }]);
});
