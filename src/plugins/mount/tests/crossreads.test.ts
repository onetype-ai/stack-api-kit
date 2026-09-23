import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { definePlugin } from "../../kernel/api";
import { start } from "../api";
import { testDatabase } from "../../../testing/tests/testDatabase";
import { column, table } from "../../database/api";

const from = fileURLToPath(new URL("./migrations", import.meta.url));

const holders = table("holders", { id: column.text("id").primaryKey() });
const abbot = table("abbot", { id: column.text("id").primaryKey() });

const holding = definePlugin("holding", {
    version: "1.0.0",
    describe: "Holds what another reads.",
    tables: { holders },
    migrations: `${from}/holding`,
});

// Named to sort before holding's table on purpose: without the check this boots or refuses depending on nothing but the name, which is the defect.
const sneaking = definePlugin("abbot", {
    version: "1.0.0",
    describe: "Reads a table it never declared a dependency on.",
    tables: { abbot },
    migrations: `${from}/abbot`,
});

describe("a migration reading another plugin's table", () =>
{
    test("refuses to start when nothing declared the dependency", async () =>
    {
        await expect(start({ plugins: [holding, sneaking], database: await testDatabase() }))
            .rejects.toThrow(/reads "holders", which "holding" creates/);

        await expect(start({ plugins: [holding, sneaking], database: await testDatabase() }))
            .rejects.toThrow(/Add "holding" to dependsOn/);
    });
});
