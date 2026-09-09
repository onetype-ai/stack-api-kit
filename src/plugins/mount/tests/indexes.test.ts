import { describe, expect, test } from "vitest";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { definePlugin } from "../../kernel/api";
import { start } from "../api";

const from = new URL("./migrations", import.meta.url).pathname;

const seats = sqliteTable("seats", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
}, (table) => [uniqueIndex("seats_email").on(table.email)]);

const chairs = sqliteTable("chairs", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
}, (table) => [uniqueIndex("chairs_email").on(table.email)]);

/** Declares an index its migration creates. */
const seating = definePlugin("seating", {
    version: "1.0.0",
    describe: "Declares an index and creates it.",
    tables: { seats },
    migrations: `${from}/indexed`,
});

/** Declares one no migration creates, so it never reaches the database. */
const sitting = definePlugin("sitting", {
    version: "1.0.0",
    describe: "Declares an index nothing creates.",
    tables: { chairs },
    migrations: `${from}/unindexed`,
});

describe("an index a table declares", () =>
{
    test("boots when a migration creates it", async () =>
    {
        const api = await start({ plugins: [seating], database: { file: ":memory:" } });

        await api.stop();
    });

    test("refuses to start when no migration creates it, naming both sides", async () =>
    {
        // Never a warning: a uniqueIndex nobody created reads as a guarantee
        // and accepts the duplicate it was declared to stop, with nothing
        // failing anywhere.
        await expect(start({ plugins: [sitting], database: { file: ":memory:" } }))
            .rejects.toThrow(/uniqueIndex "chairs_email" on "chairs"/);

        await expect(start({ plugins: [sitting], database: { file: ":memory:" } }))
            .rejects.toThrow(/CREATE UNIQUE INDEX chairs_email/);
    });
});
