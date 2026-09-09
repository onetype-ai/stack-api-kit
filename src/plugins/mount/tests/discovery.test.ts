import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createKernel } from "../../kernel/api";
import { discoverFrom } from "../api";

const KIT = join(import.meta.dirname, "..", "..", "..", "index.ts");

/** A folder of plugin folders, as a project's src/plugins looks on disk. */
function project(folders: Readonly<Record<string, Readonly<Record<string, string>>>>): string
{
    const root = mkdtempSync(join(tmpdir(), "stack-api-discovery-"));

    for (const [folder, files] of Object.entries(folders))
    {
        mkdirSync(join(root, folder));

        for (const [name, text] of Object.entries(files))
        {
            writeFileSync(join(root, folder, name), text);
        }
    }

    return root;
}

/** What a finished plugin.ts says. */
function contract(name: string, extra = ""): string
{
    return `import { definePlugin } from "${KIT}";\nexport default definePlugin("${name}", { version: "1.0.0", describe: "Answers.", ${extra} });\n`;
}

describe("discovering plugins from a folder", () =>
{
    test("finds the finished ones and names what it stepped over", async () =>
    {
        const root = project({
            done: { "plugin.ts": contract("done") },
            halfway: { "notes.ts": "export const x = 1;" },
        });

        const found = await discoverFrom(root);

        expect(found.plugins.map((one) => one.name)).toEqual(["done"]);
        expect(found.skipped).toEqual([{ folder: "halfway", why: "holds no plugin.ts" }]);
    });

    test("carries the reason when a plugin.ts cannot be loaded", async () =>
    {
        const root = project({
            done: { "plugin.ts": contract("done") },
            broken: { "plugin.ts": `import { nope } from "./nowhere";\nexport default nope;\n` },
        });

        const found = await discoverFrom(root);

        expect(found.plugins.map((one) => one.name)).toEqual(["done"]);
        expect(found.skipped[0]?.folder).toBe("broken");
        expect(found.skipped[0]?.why).toMatch(/Cannot find module/);
    });

    test("says so when plugin.ts default-exports nothing", async () =>
    {
        const root = project({ empty: { "plugin.ts": "export const notDefault = 1;\n" } });

        const found = await discoverFrom(root);

        expect(found.plugins).toEqual([]);
        expect(found.skipped).toEqual([{ folder: "empty", why: "plugin.ts default-exports nothing" }]);
    });

    test("hides nothing: whoever depends on a skipped one is refused by name", async () =>
    {
        const root = project({
            worker: { "notes.ts": "export const x = 1;" },
            reader: { "plugin.ts": contract("reader", `dependsOn: ["worker"]`) },
        });

        const found = await discoverFrom(root);
        const kernel = createKernel({ plugins: found.plugins });

        // Stepping over a folder is not the same as pretending nobody wanted
        // it: a missing region is loud wherever it actually matters.
        await expect(kernel.start()).rejects.toThrow(/"reader" depends on "worker", which no plugin provides/);
    });

    test("answers one order, whatever the filesystem walked first", async () =>
    {
        const root = project({
            zebra: { "plugin.ts": contract("zebra") },
            alpha: { "plugin.ts": contract("alpha") },
        });

        expect((await discoverFrom(root)).plugins.map((one) => one.name)).toEqual(["alpha", "zebra"]);
    });
});
