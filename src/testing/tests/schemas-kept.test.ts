import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { definePlugin } from "../../index";
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
    const schemas = async (): Promise<number> => (await (await sharedPglite()).query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'kernel_${String(process.pid)}_%'`)).rows[0]?.count ?? 0;
    const before = await schemas();

    for (let which = 0; which < 14; which += 1)
    {
        const api = await startTestKernel({ plugins: [migrating(which)] });

        await api.stop();
    }

    expect(await schemas()).toBeLessThanOrEqual(before + 3);
}, 120_000);

test("a worker starts a fresh PGlite once it migrated many schemas and nothing holds the old one", async () =>
{
    const before = await sharedPglite();

    for (let which = 100; which < 130; which += 1)
    {
        const api = await startTestKernel({ plugins: [migrating(which)] });

        await api.stop();
    }

    expect(await sharedPglite()).not.toBe(before);
}, 240_000);

