import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Packer } from "../packing";

let at = "";
let was = "";

function wrote(files: Record<string, string>): void
{
    for (const [name, body] of Object.entries(files))
    {
        const path = join(at, name);

        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, body);
    }
}

beforeEach(() =>
{
    at = mkdtempSync(join(tmpdir(), "packing-"));
    was = process.cwd();

    process.chdir(at);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() =>
{
    process.chdir(was);
    vi.restoreAllMocks();
});

describe("a folder folded into one file", () =>
{
    test("writes back byte for byte", () =>
    {
        wrote({
            "src/one/plugin.ts": "export const one = 1;\n",
            "src/one/deep/held.ts": "export const held = 2;\n",
        });

        const packer = (): Packer => new Packer({ at: "src", demo: ["one"], name: "unit", tool: "units" });

        packer().pack([]);

        expect(existsSync(join(at, "src", "one"))).toBe(false);

        packer().unpack();

        expect(readFileSync(join(at, "src/one/plugin.ts"), "utf8")).toBe("export const one = 1;\n");
        expect(readFileSync(join(at, "src/one/deep/held.ts"), "utf8")).toBe("export const held = 2;\n");
    });

    test("and packing what was written back answers the same file", () =>
    {
        wrote({ "src/one/plugin.ts": "export const one = 1;\n" });

        const packer = (): Packer => new Packer({ at: "src", demo: ["one"], name: "unit", tool: "units" });

        packer().pack([]);

        const first = readFileSync(join(at, "src/example.txt"), "utf8");

        packer().unpack();
        packer().pack([]);

        expect(readFileSync(join(at, "src/example.txt"), "utf8")).toBe(first);
    });

    test("takes a file beside the folder with it, not only a folder", () =>
    {
        wrote({ "src/One.ts": "export const one = 1;\n" });

        new Packer({ at: "src", demo: ["One"], name: "unit", tool: "units" }).pack([]);

        expect(existsSync(join(at, "src", "One.ts"))).toBe(false);
    });
});

describe("a document past the limit", () =>
{
    test("is refused at the pack rather than counted later", () =>
    {
        wrote({ "docs/long.md": "x".repeat(2001) });

        const packing = (): void =>
        {
            new Packer({ at: "docs", into: "docs.md", name: "document", tool: "docs", limit: 2000 }).pack([]);
        };

        expect(packing).toThrow(/2001 characters, over the 2000/);
    });

    test("while a limit answering per file lets one kind be longer", () =>
    {
        wrote({ "docs/short.md": "x".repeat(100), "docs/reference.md": "x".repeat(2001) });

        const packing = (): void =>
        {
            new Packer({
                at: "docs",
                into: "docs.md",
                name: "document",
                tool: "docs",
                limit: (path) => (path.endsWith("reference.md") ? 6600 : 2000),
            }).pack([]);
        };

        expect(packing).not.toThrow();
    });
});
