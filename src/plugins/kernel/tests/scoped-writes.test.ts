import { expect, test } from "vitest";

import { migrationsOf, openStore } from "../../database/tests/openStore";
import { createKernel, definePlugin } from "../api";
import { column, table } from "../../database/api";

import type { PortableDb } from "../../database/api";

const notes = table("billing_notes", {
    id: column.text("id").primaryKey(),
    tenantId: column.text("tenant_id").notNull(),
    body: column.text("body").notNull(),
});

test("a write carries the caller's scope, not the one it asked for", async () =>
{
    const store = await openStore({ billing: { notes } });

    await store.migrate([{ plugin: "billing", from: migrationsOf("CREATE TABLE billing_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, body TEXT NOT NULL)") }]);

    const kernel = createKernel({
        plugins: [definePlugin("billing", {
            version: "1.0.0",
            describe: "Notes.",
            tables: { notes },
            scope: { describe: "The account.", claim: "tenantId", tables: { notes: "tenantId" } },
            services: (ctx) => ({
                plant: async (): Promise<void> =>
                {
                    // A caller in "acme" writing a row for "other": what they asked for is overwritten by the stamp.
                    await (ctx.db as { insert: Function })
                        .insert(notes)
                        .values({ id: "x", tenantId: "other", body: "planted", ...ctx.stamped("notes") });
                },
            }),
        })],
        db: store,
        ...(store.createScopeFilter !== undefined && { scopeFilter: store.createScopeFilter() }),
    });

    await kernel.start();

    const mine = kernel.context("billing", { id: "u1", permissions: [], claims: { tenantId: "acme" } });

    await (mine.services as { plant: () => Promise<void> }).plant();

    const rows = await (store.forPlugin("billing") as PortableDb).select({ tenant_id: notes.tenantId }).from(notes);

    await kernel.stop();
    await store.close();

    expect(rows).toEqual([{ tenant_id: "acme" }]);
});
