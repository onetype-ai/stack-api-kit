import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { createKernel, definePlugin } from "../api";

const items = sqliteTable("probe_items", { id: text("id").primaryKey(), title: text("title").notNull() });

type Rows = BetterSQLite3Database<{ items: typeof items }>;

describe("what a plugin gets without writing a cast", () =>
{
    test("names its own db type and keeps config inferred", async () =>
    {
        let seen: unknown;

        type Services = { query: () => unknown; size: () => number };

        const plugin = definePlugin.over<Rows, Services>()("probe", {
            version: "1.0.0",
            describe: "Queries its own tables.",
            tables: { items },
            config: z.object({ size: z.number().default(10) }),
            services: (ctx) =>
            {
                // Neither line may need a cast: ctx.db is the handle, and
                // ctx.config is what the schema parsed. Built lazily, because
                // this test is about what typechecks rather than what runs.
                const size: number = ctx.config.size;

                return {
                    query: () => ctx.db.select().from(items),
                    size: () => size,
                };
            },
            setup: (ctx) =>
            {
                seen = ctx.services.size();
            },
        });

        const kernel = createKernel({
            plugins: [plugin],
            db: { of: () => ({}), tx: (_plugin, run) => run({}) },
            config: { probe: { size: 42 } },
        });

        await kernel.start();

        expect(seen).toBe(42);
    });

    test("stays usable for a plugin that touches no database", async () =>
    {
        const plugin = definePlugin("quiet", {
            version: "1.0.0",
            describe: "Holds no tables.",
            config: z.object({ loud: z.boolean().default(false) }),
            services: (ctx) => ({ loud: () => ctx.config.loud }),
        });

        const kernel = createKernel({ plugins: [plugin] });

        await kernel.start();

        expect((kernel.context("quiet").services as { loud: () => boolean }).loud()).toBe(false);
    });
});
