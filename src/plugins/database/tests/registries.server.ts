import { afterEach, beforeEach, expect, test } from "vitest";

import { postgres } from "../api";

import type { PostgresStore } from "../api";

// Two processes changing one scope's registry at once: what the version must survive, and PGlite cannot show.
const url = process.env["KIT_PG_URL"];

if (url === undefined || url === "")
{
    throw new Error("KIT_PG_URL is not set, so there is no Postgres server to test against. Run infra/remote-verify.sh --with-pg --lane kit <kit> \"pnpm test:pg\".");
}

let storeA: PostgresStore;
let storeB: PostgresStore;

beforeEach(async () =>
{
    storeA = await postgres({ url, tables: {} });
    storeB = await postgres({ url, tables: {} });

    await Promise.all([storeA.migrate([]), storeB.migrate([])]);
});

afterEach(async () =>
{
    await storeA.close();
    await storeB.close();
});

const CHANGES = 100;

test("two processes setting entries in one scope at once give each change its own version, with no gap", async () =>
{
    const registryA = storeA.registries();
    const registryB = storeB.registries();
    const scope = crypto.randomUUID();

    const change = (store: PostgresStore, registry: typeof registryA, which: number): Promise<number> =>
        store.tx("editor", (db) => registry.save(db, { registry: "editor.blocks", scope, key: `entry-${String(which % 7)}`, plugin: "editor", entry: { id: `entry-${String(which % 7)}`, label: String(which) } }).then((saved) => saved.version));

    const versions = await Promise.all(Array.from({ length: CHANGES }, (_unused, which) => change(which % 2 === 0 ? storeA : storeB, which % 2 === 0 ? registryA : registryB, which)));
    const listed = await registryA.list("editor.blocks", scope);

    expect([...versions].sort((first, second) => first - second)).toEqual(Array.from({ length: CHANGES }, (_unused, at) => at + 1));
    expect(listed.version).toBe(CHANGES);
    expect(Math.max(...listed.entries.map((entry) => entry.version))).toBe(CHANGES);
});
