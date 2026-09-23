import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

import { definePlugin } from "../../kernel/api";
import { start } from "../api";
import { testDatabase } from "../../../testing/tests/testDatabase";
import { column, table } from "../../database/api";

const from = fileURLToPath(new URL("./migrations", import.meta.url));

const holders = table("holders", { id: column.text("id").primaryKey() });
const heldTable = table("held", { id: column.text("id").primaryKey() });

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
    tables: { held: heldTable },
    migrations: `${from}/held`,
});

describe("migrations run in dependency order", () =>
{
    test("a plugin passed before the one it depends on still migrates after it", async () =>
    {
        const api = await start({ plugins: [heldBy, holding], database: await testDatabase() });

        await api.stop();
    });

    test("the order a project passes changes nothing", async () =>
    {
        const api = await start({ plugins: [holding, heldBy], database: await testDatabase() });

        await api.stop();
    });
});
