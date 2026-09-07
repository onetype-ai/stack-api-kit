import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { findUnusedFields } from "../wiring";

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
    root = mkdtempSync(join(tmpdir(), "wiring-"));

    for (const [path, source] of Object.entries(files))
    {
        const full = join(root, path);

        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, source);
    }

    return root;
}

describe("a declared field", () =>
{
    test("passes when something reads it", () =>
    {
        const problems = findUnusedFields(
            tree({
                "shape.ts": "export type Item = { title: string };",
                "use.ts": 'import type { Item } from "./shape";\nexport const name = (one: Item) => one.title;',
            }),
        );

        expect(problems).toEqual([]);
    });

    test("is reported when nothing does", () =>
    {
        const problems = findUnusedFields(
            tree({
                "shape.ts": "export type Item = { title: string; unused: number };",
                "use.ts": 'import type { Item } from "./shape";\nexport const name = (one: Item) => one.title;',
            }),
        );

        expect(problems.map((unused) => unused.field)).toEqual(["unused"]);
        expect(problems[0]?.shape).toBe("Item");
    });

    test("counts a read through destructuring", () =>
    {
        const problems = findUnusedFields(
            tree({
                "shape.ts": "export type Item = { title: string };",
                "use.ts": 'import type { Item } from "./shape";\nexport const name = (one: Item) => { const { title } = one; return title; };',
            }),
        );

        expect(problems).toEqual([]);
    });

    test("does not count a parameter inside a function type", () =>
    {
        const problems = findUnusedFields(tree({ "shape.ts": "export type Log = { info: (line: string, about?: object) => void };\nexport const write = (log: Log) => log.info(\"x\");" }));

        expect(problems).toEqual([]);
    });

    test("sees a field read far below its own declaration", () =>
    {
        const problems = findUnusedFields(
            tree({
                "shape.ts": "export type Item = { title: string };\n\nconst pad = 1;\nvoid pad;\n\nexport const name = (one: Item) => one.title;",
            }),
        );

        expect(problems).toEqual([]);
    });
});

test("a field named only in a comment is not a read", () =>
{
    const at = mkdtempSync(join(tmpdir(), "wiring-comment-"));

    mkdirSync(join(at, "problems"), { recursive: true });
    writeFileSync(join(at, "problems", "api.ts"), [
        "export type Result = {",
        "    used: string;",
        "    promised: string;",
        "};",
        "",
        "// TODO: someday we will honour `promised`.",
        "export function reads(problems: Result): string",
        "{",
        "    return problems.used;",
        "}",
    ].join("\n"));

    expect(findUnusedFields(at)).toEqual([{ file: "problems/api.ts", shape: "Result", field: "promised" }]);

    rmSync(at, { recursive: true, force: true });
});

test("a field read only by a test is not a read", () =>
{
    const at = mkdtempSync(join(tmpdir(), "wiring-test-"));

    mkdirSync(join(at, "problems", "tests"), { recursive: true });
    writeFileSync(join(at, "problems", "api.ts"), [
        "export type Result = {",
        "    used: string;",
        "    fixtured: string;",
        "};",
        "",
        "export function reads(problems: Result): string",
        "{",
        "    return problems.used;",
        "}",
    ].join("\n"));
    writeFileSync(join(at, "problems", "tests", "api.test.ts"), 'const made = { used: "a", fixtured: "b" };\n');

    expect(findUnusedFields(at)).toEqual([{ file: "problems/api.ts", shape: "Result", field: "fixtured" }]);

    rmSync(at, { recursive: true, force: true });
});
