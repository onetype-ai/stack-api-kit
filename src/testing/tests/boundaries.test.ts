import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { findImportViolations } from "../boundaries";

let root = "";

afterEach(() =>
{
    if (root !== "")
    {
        rmSync(root, { recursive: true, force: true });
        root = "";
    }
});

/** Writes a plugin tree on disk, because that is what the check reads. */
function tree(plugins: Readonly<Record<string, Readonly<Record<string, string>>>>): string
{
    root = mkdtempSync(join(tmpdir(), "boundaries-"));

    for (const [name, files] of Object.entries(plugins))
    {
        for (const [path, source] of Object.entries(files))
        {
            const full = join(root, name, path);

            mkdirSync(join(full, ".."), { recursive: true });
            writeFileSync(full, source);
        }
    }

    return root;
}

const contractFor = (name: string, needs: readonly string[] = []): string =>
    `export default definePlugin("${name}", { dependsOn: [${needs.map((one) => `"${one}"`).join(", ")}] });`;

describe("a plugin reaching another", () =>
{
    test("passes when it is declared and goes through the public index", () =>
    {
        const found = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import { useAuth } from "@plugins/auth";',
                },
            }),
        );

        expect(found).toEqual([]);
    });

    test("refuses an import nothing declared", () =>
    {
        const found = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo"),
                    "services/items.ts": 'import { useAuth } from "@plugins/auth";',
                },
            }),
        );

        expect(found.map((one) => one.rule)).toContain("undeclared");
        expect(found[0]?.message).toMatch(/without declaring "auth"/);
    });

    test("refuses a reach past the public index", () =>
    {
        const found = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import { Session } from "@plugins/auth/types/Session";',
                },
            }),
        );

        expect(found.map((one) => one.rule)).toContain("deep");
    });

    test("refuses a relative path that climbs into another plugin", () =>
    {
        const found = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth"), "types/Session.ts": "export type Session = { id: string };" },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import type { Session } from "../../auth/types/Session";',
                },
            }),
        );

        expect(found.map((one) => one.rule)).toContain("deep");
        expect(found.some((one) => one.message.includes("../../auth/types/Session"))).toBe(true);
    });

    test("ignores a relative import inside one plugin", () =>
    {
        const found = findImportViolations(
            tree({
                demo: {
                    "plugin.ts": contractFor("demo"),
                    "services/items.ts": 'import { DemoItem } from "../types/DemoItem";',
                    "types/DemoItem.ts": "export type DemoItem = { id: string };",
                },
            }),
        );

        expect(found).toEqual([]);
    });
});

describe("cycles", () =>
{
    test("names a loop between two plugins", () =>
    {
        const found = findImportViolations(
            tree({
                a: { "plugin.ts": contractFor("a", ["b"]), "use.ts": 'import { b } from "@plugins/b";' },
                b: { "plugin.ts": contractFor("b", ["a"]), "use.ts": 'import { a } from "@plugins/a";' },
            }),
        );

        const cycle = found.find((one) => one.rule === "cycle");

        expect(cycle?.message).toMatch(/a -> b -> a|b -> a -> b/);
    });

    test("a one-way dependency is not a cycle", () =>
    {
        const found = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: { "plugin.ts": contractFor("demo", ["auth"]), "use.ts": 'import { auth } from "@plugins/auth";' },
            }),
        );

        expect(found.filter((one) => one.rule === "cycle")).toEqual([]);
    });
});

describe("what a test may reach", () =>
{
    function built(declared: string): string
    {
        const at = mkdtempSync(join(tmpdir(), "boundaries-tests-"));

        mkdirSync(join(at, "orders", "tests"), { recursive: true });
        mkdirSync(join(at, "catalog"), { recursive: true });

        writeFileSync(join(at, "orders", "plugin.ts"), `export default definePlugin("orders", { dependsOn: [${declared}] });\n`);
        writeFileSync(join(at, "catalog", "plugin.ts"), 'export default definePlugin("catalog", {});\n');

        return at;
    }

    test("a test may boot a dependency it declared", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at)).toEqual([]);

        rmSync(at, { recursive: true, force: true });
    });

    test("a test may not boot a plugin it never declared", () =>
    {
        const at = built("");

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule).sort()).toEqual(["deep", "undeclared"]);

        rmSync(at, { recursive: true, force: true });
    });

    test("a test may not reach past a dependency's contract", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import { rows } from "@plugins/catalog/tables/rows";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule)).toEqual(["deep"]);

        rmSync(at, { recursive: true, force: true });
    });

    test("code outside tests may not name a contract at all", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "services.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule)).toEqual(["deep"]);

        rmSync(at, { recursive: true, force: true });
    });
});
