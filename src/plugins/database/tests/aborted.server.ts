import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";

import { postgres } from "../api";

import type { PostgresStore } from "../api";

// What Postgres alone does: a statement failing inside a transaction refuses every statement after it.
const url = process.env["KIT_PG_URL"];

if (url === undefined || url === "")
{
    throw new Error("KIT_PG_URL is not set, so there is no Postgres server to test against. Run infra/remote-verify.sh --with-pg --lane kit <kit> \"pnpm test:pg\".");
}

let store: PostgresStore;

beforeEach(async () =>
{
    store = await postgres({ url, tables: { items: {} } });
    await store.migrate([]);
});

afterEach(async () =>
{
    await store.close();
});

test("names the statement that failed first when a later one is refused for the aborted transaction", async () =>
{
    const table = `aborted_${crypto.randomUUID().replaceAll("-", "")}`;

    const failed = store.tx("items", async (db) =>
    {
        const handle = db as { execute: (query: unknown) => Promise<unknown> };

        await handle.execute(sql.raw(`CREATE TABLE "${table}" ("id" text PRIMARY KEY)`));
        await handle.execute(sql.raw(`INSERT INTO "${table}" VALUES ('a')`));
        await handle.execute(sql.raw(`INSERT INTO "${table}" VALUES ('a')`)).catch(() => undefined);
        await handle.execute(sql.raw(`SELECT 1`));
    });

    await expect(failed).rejects.toThrow(/A statement failed inside this transaction \(.*duplicate key.*\), and Postgres refuses every statement after it/u);
});
