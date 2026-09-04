import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { missing, oversized, undocumented } from "../docs";

let root = "";

afterEach(() =>
{
    if (root !== "")
    {
        rmSync(root, { recursive: true, force: true });
        root = "";
    }
});

function tree(files: Readonly<Record<string, string>>): string
{
    root = mkdtempSync(join(tmpdir(), "docs-"));

    for (const [path, body] of Object.entries(files))
    {
        const full = join(root, path);

        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body);
    }

    return root;
}

describe("oversized", () =>
{
    test("names a document past the limit, with its size", () =>
    {
        const found = oversized(tree({ "contract.md": "x".repeat(1801) }));

        expect(found).toHaveLength(1);
        expect(found[0]?.size).toBe(1801);
    });

    test("passes a document at the limit", () =>
    {
        expect(oversized(tree({ "contract.md": "x".repeat(1800) }))).toEqual([]);
    });

    test("ignores progress, which is a log rather than a contract", () =>
    {
        const found = oversized(tree({ "progress/done.md": "x".repeat(5000) }));

        expect(found).toEqual([]);
    });

    test("an absent folder is not a failure", () =>
    {
        expect(oversized(join(tmpdir(), "nothing-here-at-all"))).toEqual([]);
    });
});

describe("missing", () =>
{
    test("reports one that is absent", () =>
    {
        expect(missing(tree({ "usage.md": "found" }), ["usage.md", "gone.md"])).toEqual(["gone.md"]);
    });

    test("reports one that is present but empty", () =>
    {
        expect(missing(tree({ "usage.md": "   \n  " }), ["usage.md"])).toEqual(["usage.md"]);
    });
});

describe("undocumented", () =>
{
    const contract = `export type Definition = {
    version: string;
    grants?: () => string[];
};`;

    test("names a key the procedure never mentions", () =>
    {
        expect(undocumented(contract, "- `version` — the version.")).toEqual(["grants"]);
    });

    test("passes when every key is named", () =>
    {
        expect(undocumented(contract, "- `version` and `grants`.")).toEqual([]);
    });
});
