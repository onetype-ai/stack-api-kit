import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test } from "vitest";

import type { Storage } from "../../kernel/api";
import { database, type Store } from "../api";

const rows = sqliteTable("rows", { id: text("id").primaryKey() });

test("what database opens is what a project holds, and what the kernel takes", () =>
{
    const store: Store = database({ file: ":memory:", tables: { a: { rows } } });

    // The kernel's view is narrower, and a store satisfies it without help:
    // one is a subset of the other rather than a separate shape to adapt.
    const found: Storage = store;

    expect(typeof store.migrate).toBe("function");
    expect(typeof store.close).toBe("function");
    expect(typeof found.of).toBe("function");

    store.close();
});
