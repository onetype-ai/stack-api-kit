import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { definePlugin } from "../../kernel/api";
import { start } from "../api";

const from = fileURLToPath(new URL("./migrations", import.meta.url));

const holders = sqliteTable("holders", { id: text("id").primaryKey() });
const abbot = sqliteTable("abbot", { id: text("id").primaryKey() });

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
        await expect(start({ plugins: [holding, sneaking], database: { file: ":memory:" } }))
            .rejects.toThrow(/reads "holders", which "holding" creates/);

        await expect(start({ plugins: [holding, sneaking], database: { file: ":memory:" } }))
            .rejects.toThrow(/Add "holding" to dependsOn/);
    });
});
