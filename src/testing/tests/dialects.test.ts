import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { Project } from "../project";

// A project's src/plugins, written out: path to content.
function plugins(files: Readonly<Record<string, string>>): string
{
    const root = mkdtempSync(join(tmpdir(), "kit-dialects-"));

    for (const [path, content] of Object.entries(files))
    {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }

    return root;
}

describe("[migrations]", () =>
{
    test.each([
        ["a step generated for one dialect and not the other", { "items/migrations/sqlite/0000_items.sql": "x", "items/migrations/sqlite/0001_tags.sql": "x", "items/migrations/postgres/0000_items.sql": "x" }, ["items/migrations/sqlite/0001_tags.sql has no twin in postgres"]],
        ["one dialect's folder alone", { "items/migrations/postgres/0000_items.sql": "x" }, ["items/migrations/postgres/0000_items.sql has no twin in sqlite"]],
        ["the same steps in both", { "items/migrations/sqlite/0000_items.sql": "x", "items/migrations/postgres/0000_items.sql": "y" }, []],
        ["one folder of files, SQLite alone as before 9.0", { "items/migrations/0001-init.sql": "x" }, []],
    ] as const)("%s", (_what, files, expected) =>
    {
        const found = Project.findMigrationDrift(plugins(files)).map((problem) => problem.message);

        expect(found.map((message) => expected.find((part) => message.includes(part)) ?? message)).toEqual(expected);
        expect(Project.findMigrationDrift(plugins(files)).every((problem) => problem.check === "migrations")).toBe(true);
    });
});

describe("[dialect]", () =>
{
    test.each([
        ["a row read with .get()", "const [row] = [await this.#ctx.db.select().from(items).where(where).get()];", ".get(), which only SQLite answers", "take its first row"],
        ["rows read with .all()", "const rows = this.#ctx.db.select().from(items).all();", ".all(), which only SQLite answers", "await the query itself"],
        ["a write run with .run(), past an object literal", "inside.db.insert(items).values({ id, title }).run();", ".run(), which only SQLite answers", "await the statement itself"],
    ])("names %s and its portable replacement", (_what, line, named, replacement) =>
    {
        const found = Project.findSqliteOnlyCalls(plugins({ "items/services/items.ts": `export async function work()\n{\n    ${line}\n}\n` }));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ check: "dialect", message: expect.stringContaining(named) });
        expect(found[0]?.message).toContain(replacement);
        expect(found[0]?.message).toContain("items/services/items.ts:3");
    });

    test.each([
        ["a query awaited as it is", "const rows = await this.#ctx.db.select().from(items);"],
        ["a map's get", "const kept = this.#seen.get(id);"],
        ["a command run with its input", "await ctx.commands.run(\"items.archive\", { id });"],
        ["a get with no database in sight", "const value = settings.get();"],
    ])("passes %s", (_what, line) =>
    {
        expect(Project.findSqliteOnlyCalls(plugins({ "items/services/items.ts": `export async function work()\n{\n    ${line}\n}\n` }))).toEqual([]);
    });
});
