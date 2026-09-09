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

function createProject(docs: Readonly<Record<string, string>> = {}): string
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
        "outbound", "scope", "services", "routes", "emits", "channels", "listens", "hooks", "participates",
        "commands", "identifies", "grants", "mayGrant",
        "setup", "teardown"].map((key) => `- \`${key}\``).join("\n");
}

describe("what a project checks about itself", () =>
{
    test("says nothing when everything holds", () =>
    {
        const at = createProject();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());

        expect(Project.checks({ root: at })).toEqual([]);
    });

    test("names a plugin that explains itself nowhere", () =>
    {
        const at = createProject();

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
        const at = createProject();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), "- `version`\n");

        const wrong = Project.checks({ root: at });

        expect(wrong.every((problem) => problem.check === "undocumented")).toBe(true);
        expect(wrong.length).toBeGreaterThan(1);
    });

    test("finds its own contract without the project naming a path", () =>
    {
        const at = createProject();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());

        // Nothing here points at the kit: a project reaching into
        // packages/…/internal to check itself is the thing this replaces.
        expect(Project.checks({ root: at })).toEqual([]);
    });

    test("a plugin leaving the process is reported, and named in \"leaving\" it is not", () =>
    {
        const at = createProject();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());
        writeFileSync(join(at, "src", "plugins", "found", "Runs.ts"), 'import { spawn } from "node:child_process";\n');

        const loud = Project.checks({ root: at });

        expect(loud).toHaveLength(1);
        expect(loud[0]?.message).toContain("node:child_process");
        expect(loud[0]?.message).toContain("\"leaving\"");

        expect(Project.checks({ root: at, leaving: ["found"] })).toEqual([]);
    });

    test("naming one plugin in \"leaving\" does not excuse another", () =>
    {
        const at = createProject();

        writeFileSync(join(at, "#docs", "procedures", "plugin", "contract.md"), procedure());
        writeFileSync(join(at, "src", "plugins", "found", "Runs.ts"), 'import { spawn } from "node:child_process";\n');

        expect(Project.checks({ root: at, leaving: ["elsewhere"] })).toHaveLength(1);
    });

});
