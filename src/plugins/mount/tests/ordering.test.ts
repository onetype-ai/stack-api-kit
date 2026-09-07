import { describe, test } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { definePlugin } from "../../kernel/api";
import { start } from "../api";

const from = new URL("./migrations", import.meta.url).pathname;

const holders = sqliteTable("holders", { id: text("id").primaryKey() });
const held = sqliteTable("held", { id: text("id").primaryKey() });

/** The one whose table the other reads: it must migrate first. */
const holding = definePlugin("holding", {
    version: "1.0.0",
    describe: "Holds what another reads.",
    tables: { holders },
    migrations: `${from}/holding`,
});

/** Depends on holding, and its migration reads that plugin's table. */
const heldBy = definePlugin("held", {
    version: "1.0.0",
    describe: "Reads what holding wrote.",
    dependsOn: ["holding"],
    tables: { held },
    migrations: `${from}/held`,
});

describe("migrations run in dependency order", () =>
{
    test("a plugin passed before the one it depends on still migrates after it", async () =>
    {
        const api = await start({ plugins: [heldBy, holding], database: { file: ":memory:" } });

        await api.stop();
    });

    test("the order a project passes changes nothing", async () =>
    {
        const api = await start({ plugins: [holding, heldBy], database: { file: ":memory:" } });

        await api.stop();
    });
});
