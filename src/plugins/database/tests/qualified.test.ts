import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { column, dialect, table } from "../api";
import { openStore, type OpenedStore } from "./openStore";

import type { PortableDb } from "../api";

const notes = table("items_notes", {
    id: column.id().primaryKey(),
    workspaceId: column.text("workspace_id").notNull(),
    text: column.text("text").notNull(),
});

// what drizzle-kit writes: Postgres names each referenced table in "public", and quoted text may hold the same words
const MIGRATIONS = {
    "sqlite/0000_notes.sql": `
        CREATE TABLE "items_workspaces" ("id" TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE "items_notes" ("id" TEXT PRIMARY KEY NOT NULL, "workspace_id" TEXT NOT NULL REFERENCES "items_workspaces"("id"), "text" TEXT NOT NULL);
        INSERT INTO "items_workspaces" ("id") VALUES ('w1');
        INSERT INTO "items_notes" ("id", "workspace_id", "text") VALUES ('n1', 'w1', 'kept as "public".written');`,
    "postgres/0000_notes.sql": `
        CREATE TABLE "items_workspaces" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "items_notes" ("id" text PRIMARY KEY NOT NULL, "workspace_id" text NOT NULL, "text" text NOT NULL);
        -- a comment naming "public"."items_notes" is left as it is
        ALTER TABLE "items_notes" ADD CONSTRAINT "items_notes_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."items_workspaces"("id") ON DELETE cascade ON UPDATE no action;
        INSERT INTO "public"."items_workspaces" ("id") VALUES ('w1');
        INSERT INTO "items_notes" ("id", "workspace_id", "text") VALUES ('n1', 'w1', 'kept as "public".written');`,
};

let store: OpenedStore | undefined;

afterEach(async () =>
{
    await store?.close();
    store = undefined;
});

function migrations(): string
{
    const from = mkdtempSync(join(tmpdir(), "kit-qualified-"));

    for (const [path, text] of Object.entries(MIGRATIONS))
    {
        mkdirSync(join(from, path, ".."), { recursive: true });
        writeFileSync(join(from, path), text);
    }

    return from;
}

test(`runs a migration naming its tables in "public" inside a store's own schema, leaving quoted text as written, on ${dialect()}`, async () =>
{
    store = await openStore({ items: { notes } });

    await store.migrate([{ plugin: "items", from: migrations() }]);
    const read = await (store.forPlugin("items") as PortableDb<{ notes: typeof notes }>).select({ text: notes.text }).from(notes);

    expect(read).toEqual([{ text: "kept as \"public\".written" }]);
});
