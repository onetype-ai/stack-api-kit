import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { Project } from "../project";

let root = "";

afterEach(() =>
{
    if (root !== "")
    {
        rmSync(root, { recursive: true, force: true });
        root = "";
    }
});

function built(docs: Readonly<Record<string, string>> = {}): string
{
    root = mkdtempSync(join(tmpdir(), "project-"));

    mkdirSync(join(root, "src", "plugins", "found"), { recursive: true });
    mkdirSync(join(root, "#docs", "procedures", "plugin"), { recursive: true });

    writeFileSync(join(root, "src", "plugins", "found", "plugin.ts"), 'export default definePlugin("found", {});\n');
    writeFileSync(join(root, "src", "plugins", "found", "api.ts"), "export const found = 1;\n");
    writeFileSync(join(root, "src", "plugins", "found", "usage.md"), "# found\n\nWhat it is for.\n");

    for (const path of Project.required)
    {
        writeFileSync(join(root, path), "Something worth reading.\n");
    }

    for (const [name, text] of Object.entries(docs))
    {
        writeFileSync(join(root, "#docs", name), text);
    }

    return root;
}

/** Every key the contract declares, so the procedure check has nothing to say. */
function procedure(): string
{
    return ["version", "describe", "dependsOn", "config", "permissions", "tables", "migrations",
        "outbound", "scope", "services", "routes", "emits", "listens", "hooks", "participates",
        "commands",
        "setup", "teardown"].map((key) => `- \`${key}\``).join("\n");
}

describe("what a project checks about itself", () =>
{
    test("says nothing when everything holds", () =>
    {
        const at = built();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());

        expect(Project.checks({ root: at })).toEqual([]);
    });

    test("names a document over the limit", () =>
    {
        const at = built({ "long.md": "x".repeat(2000) });

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());

        expect(Project.checks({ root: at })).toMatchObject([{ check: "oversized" }]);
    });

    test("names a root document that says nothing", () =>
    {
        const at = built();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());
        writeFileSync(join(at, "README.md"), "   \n");

        expect(Project.checks({ root: at })).toMatchObject([{ check: "missing", message: /README/ }]);
    });

    test("names a plugin that explains itself nowhere", () =>
    {
        const at = built();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());
        rmSync(join(at, "src", "plugins", "found", "usage.md"));

        const wrong = Project.checks({ root: at });

        expect(wrong).toEqual([{
            check: "unexplained",
            message: '"found" has no usage.md. A plugin nobody can read is one nobody can depend on.',
        }]);
    });

    test("names a contract key the procedure never mentions", () =>
    {
        const at = built();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), "- `version`\n");

        const wrong = Project.checks({ root: at });

        expect(wrong.every((one) => one.check === "undocumented")).toBe(true);
        expect(wrong.length).toBeGreaterThan(1);
    });

    test("finds its own contract without the project naming a path", () =>
    {
        const at = built();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());

        // Nothing here points at the kit: a project reaching into
        // packages/…/internal to check itself is the thing this replaces.
        expect(Project.checks({ root: at })).toEqual([]);
    });
});
