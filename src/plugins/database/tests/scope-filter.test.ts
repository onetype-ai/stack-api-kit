import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";

import { createScopeFilter } from "../api";

// two plugins may each call a table "keys": the one a plugin scopes is its own, with its own column
const accountKeys = sqliteTable("accounts_keys", { id: text("id").primaryKey(), owner: text("owner").notNull() });
const deviceKeys = sqliteTable("devices_keys", { id: text("id").primaryKey(), tenant: text("tenant").notNull() });

describe("a scope filter over two plugins naming a table alike", () =>
{
    const filter = createScopeFilter({ accounts: { keys: accountKeys }, devices: { keys: deviceKeys } });

    test("narrows the named plugin's own table", () =>
    {
        expect(() => filter("keys", "tenant", "t-1", "devices")).not.toThrow();
        expect(() => filter("keys", "owner", "t-1", "accounts")).not.toThrow();
    });

    test("never reaches the other plugin's column of the same table name", () =>
    {
        expect(() => filter("keys", "tenant", "t-1", "accounts")).toThrow("declares no such column");
    });
});
