import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { database } from "../../database/api";
import { createKernel, definePlugin, Refusal } from "../api";

import type { Caller, Plugin } from "../api";

const notes = sqliteTable("billing_notes", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    body: text("body").notNull(),
});

function billing(): Plugin
{
    return definePlugin("billing", {
        version: "1.0.0",
        describe: "Notes owned by an account.",
        tables: { notes },

        scope: {
            describe: "The account a row belongs to.",
            claim: "tenantId",
            tables: { notes: "tenantId" },
        },

        services: (ctx) => ({
            list: async (): Promise<string[]> =>
            {
                const found = await (ctx.db as { select: Function })
                    .select()
                    .from(notes)
                    .where(ctx.scoped("notes"));

                return (found as { body: string }[]).map((one) => one.body);
            },

            one: async (id: string): Promise<string | undefined> =>
            {
                const [row] = await (ctx.db as { select: Function })
                    .select()
                    .from(notes)
                    .where(and(eq(notes.id, id), ctx.scoped("notes") as never));

                return (row as { body: string } | undefined)?.body;
            },
        }),
    });
}

function serving()
{
    const store = database({ file: ":memory:", tables: { billing: { notes } } });

    store.of("billing").$client.exec(
        "CREATE TABLE billing_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, body TEXT NOT NULL)",
    );

    return store;
}

function who(tenant?: string): Caller
{
    return { id: "u1", permissions: [], claims: tenant === undefined ? {} : { tenantId: tenant } };
}

describe("a table a plugin scoped", () =>
{
    test("answers only the caller's rows, and the same 404 for another's", async () =>
    {
        const store = serving();

        store.of("billing").$client.exec(
            "INSERT INTO billing_notes VALUES ('a', 'acme', 'ours'), ('b', 'other', 'theirs')",
        );

        const kernel = createKernel({
            plugins: [billing()],
            db: store,
            ...(store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        });

        await kernel.start();

        type Reached = { list: () => Promise<string[]>; one: (id: string) => Promise<string | undefined> };

        const mine = kernel.context("billing", who("acme")).services as Reached;

        expect(await mine.list()).toEqual(["ours"]);
        expect(await mine.one("a")).toBe("ours");

        // The id is real, and guessed. It answers as one that never existed.
        expect(await mine.one("b")).toBeUndefined();

        await kernel.stop();
        store.close();
    });

    test("refuses a caller carrying no such claim, rather than defaulting", async () =>
    {
        const store = serving();

        const kernel = createKernel({
            plugins: [billing()],
            db: store,
            ...(store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        });

        await kernel.start();

        const nobody = kernel.context("billing", who()).services as { list: () => Promise<string[]> };

        await expect(nobody.list()).rejects.toThrow(Refusal);

        await kernel.stop();
        store.close();
    });

    test("refuses at startup when it scopes a table it does not own", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("wrong", {
                version: "1.0.0",
                describe: "Scopes what it has not got.",
                tables: { notes },
                scope: { describe: "x", claim: "tenantId", tables: { items: "tenantId" } },
            })],
        });

        await expect(kernel.start()).rejects.toThrow(/not one of this plugin's tables/);
    });
});
