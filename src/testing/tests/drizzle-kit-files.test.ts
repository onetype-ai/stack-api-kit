import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { definePlugin, start } from "../../index";
import { column, table, uniqueIndex } from "../../tables";
import { startTestKernel } from "../startTestKernel";
import { testDatabase } from "./testDatabase";

import type { StartedApp } from "../../index";

// what drizzle-kit writes for the same tables, once a dialect: SQLite names in backticks, Postgres in double quotes
// under "public", each statement ended by a breakpoint comment
const DRIZZLE_KIT = {
    "sqlite/0000_init.sql": [
        "CREATE TABLE `items_folders` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n--> statement-breakpoint",
        "CREATE TABLE `items_items` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`folder_id` text NOT NULL,\n\tFOREIGN KEY (`folder_id`) REFERENCES `items_folders`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint",
        "CREATE UNIQUE INDEX `items_items_folder` ON `items_items` (`folder_id`,`id`);",
    ].join("\n"),
    "postgres/0000_init.sql": [
        "CREATE TABLE \"items_folders\" (\n\t\"id\" text PRIMARY KEY NOT NULL\n);\n--> statement-breakpoint",
        "CREATE TABLE \"items_items\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"folder_id\" text NOT NULL\n);\n--> statement-breakpoint",
        "ALTER TABLE \"items_items\" ADD CONSTRAINT \"items_items_folder_fk\" FOREIGN KEY (\"folder_id\") REFERENCES \"public\".\"items_folders\"(\"id\") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint",
        "CREATE UNIQUE INDEX \"items_items_folder\" ON \"items_items\" USING btree (\"folder_id\",\"id\");",
    ].join("\n"),
};

function migrations(): string
{
    const from = mkdtempSync(join(tmpdir(), "kit-drizzle-kit-"));

    for (const [path, text] of Object.entries(DRIZZLE_KIT))
    {
        mkdirSync(join(from, path, ".."), { recursive: true });
        writeFileSync(join(from, path), text);
    }

    return from;
}

const folders = table("items_folders", { id: column.id().primaryKey() });
const items = table("items_items", { id: column.id().primaryKey(), folderId: column.text("folder_id").notNull() }, (self) => [uniqueIndex("items_items_folder").on(self.folderId, self.id)]);

const holding = (extra: Record<string, unknown> = {}) => definePlugin("items", { version: "1.0.0", describe: "Holds items in folders.", tables: { folders, items, ...extra }, migrations: migrations() });

let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

describe("migrations as drizzle-kit writes them", () =>
{
    test("start a real application", async () =>
    {
        app = await start({ plugins: [holding()], database: await testDatabase(), sockets: false });

        expect(app.kernel.started()).toBe(true);
    });

    test("start a test kernel", async () =>
    {
        const api = await startTestKernel({ plugins: [holding()] });

        expect(api.kernel.started()).toBe(true);
        await api.stop();
    });

    test("still leave a table they do not create refused, by start and by a test kernel alike", async () =>
    {
        const stray = { strays: table("items_strays", { id: column.id().primaryKey() }) };

        await expect(start({ plugins: [holding(stray)], database: await testDatabase(), sockets: false })).rejects.toThrow(/"items_strays" and nothing creates it/);
        await expect(startTestKernel({ plugins: [holding(stray)] })).rejects.toThrow(/"items_strays" and nothing creates it/);
    });
});
