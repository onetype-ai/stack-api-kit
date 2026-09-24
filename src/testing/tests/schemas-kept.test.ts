import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { column, table } from "../../plugins/database/api";
import { definePlugin } from "../../index";

import type { PortableDb } from "../../plugins/database/api";
import { sharedPglite } from "../pglite";
import { startTestKernel } from "../startTestKernel";

// a plugin whose migrations are its own, so each gives its test kernel a schema no other kernel can take again
function migrating(which: number)
{
    const from = mkdtempSync(join(tmpdir(), "kit-kept-"));

    for (const dialect of ["sqlite", "postgres"])
    {
        mkdirSync(join(from, dialect));
        writeFileSync(join(from, dialect, "0001-create.sql"), `CREATE TABLE "kept${String(which)}_rows" ("id" TEXT PRIMARY KEY NOT NULL);`);
    }

    return definePlugin(`kept${String(which)}`, { version: "1.0.0", describe: "Keeps rows.", migrations: from });
}

test("a worker keeps only a few migrated schemas however many kinds of kernel its files start", async () =>
{
    // other files in this worker may hold schemas of their own, so what is measured is what these kernels add
    const schemas = async (): Promise<number> => (await (await sharedPglite()).query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'kernel_${String(process.pid)}_%' AND nspname NOT LIKE '%\\_seed'`)).rows[0]?.count ?? 0;
    const before = await schemas();

    for (let which = 0; which < 14; which += 1)
    {
        const api = await startTestKernel({ plugins: [migrating(which)] });

        await api.stop();
    }

    expect(await schemas()).toBeLessThanOrEqual(before + 3);
}, 120_000);

test("a kernel on a schema another left reads the rows its migrations wrote, and none the other did", async () =>
{
    const from = mkdtempSync(join(tmpdir(), "kit-seeded-"));

    for (const dialect of ["sqlite", "postgres"])
    {
        mkdirSync(join(from, dialect));
        // a generated column, as full-text search keeps one, which the put-back must leave to Postgres to compute
        // Postgres alone has identity columns, whose seeded value goes back as it was
        const counted = dialect === "postgres" ? `"n" INTEGER GENERATED ALWAYS AS IDENTITY` : `"n" INTEGER`;

        writeFileSync(join(from, dialect, "0001-create.sql"), `CREATE TABLE "seeded_models" ("id" TEXT PRIMARY KEY NOT NULL, "upper" TEXT GENERATED ALWAYS AS (upper("id")) STORED, ${counted}); INSERT INTO "seeded_models" ("id") VALUES ('seed');`);
    }

    // written without the generated column, as Postgres computes it; read with it
    const models = table("seeded_models", { id: column.id().primaryKey() });
    const readable = table("seeded_models", { id: column.id().primaryKey(), upper: column.text("upper") });
    const seeded = definePlugin("seeded", { version: "1.0.0", describe: "Seeds its models.", migrations: from, tables: { models } });
    const ids = async (api: Awaited<ReturnType<typeof startTestKernel>>): Promise<string[]> => (await (api.store.forPlugin("seeded") as unknown as PortableDb<{ readable: typeof readable }>).select().from(readable)).map((row) => `${row.id}:${row.upper}`).sort();

    const first = await startTestKernel({ plugins: [seeded] });
    await (first.store.forPlugin("seeded") as unknown as PortableDb<{ models: typeof models }>).insert(models).values({ id: "written" });
    await first.stop();
    const second = await startTestKernel({ plugins: [seeded] });

    const read = await ids(second);
    await second.stop();

    expect(read).toEqual(["seed:SEED"]);
});

