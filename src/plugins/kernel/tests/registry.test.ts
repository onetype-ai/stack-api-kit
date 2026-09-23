import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";

import type { Definition, Identity, Plugin, Registry } from "../api";

function createPlugin(name: string, definition: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, { version: "1.0.0", describe: `The ${name} plugin.`, ...definition } as Definition);
}

const Block = z.object({ id: z.string(), label: z.string(), order: z.number().optional(), requires: z.array(z.string()).optional() });

function createEditor(registry: Partial<Registry> = {}, definition: Partial<Definition> = {}): Plugin
{
    return createPlugin("editor", {
        permissions: { "editor.advanced": { describe: "Uses advanced blocks." } },
        registries: { "editor.blocks": { describe: "Blocks a page is built from.", entry: Block, key: "id", ...registry } },
        ...definition,
    });
}

const createQuotes = (definition: Partial<Definition> = {}): Plugin => createPlugin("quotes", { dependsOn: ["editor"], ...definition });

const caller = (permissions: string[]): Identity => ({ id: "user-1", permissions, claims: {} });

async function started(plugins: Plugin[])
{
    const kernel = createKernel({ plugins });

    await kernel.start();

    return kernel;
}

describe("a registry", () =>
{
    test("lists what plugins added, by order and then key, whatever order they loaded in", async () =>
    {
        const kernel = await started([
            createQuotes({ adds: { "editor.blocks": [{ id: "quote", label: "Quote", order: 2 }, { id: "aside", label: "Aside", order: 2 }] } }),
            createEditor({}, { adds: { "editor.blocks": [{ id: "text", label: "Text", order: 1 }] } }),
        ]);

        const ids = kernel.context("quotes").registry("editor.blocks").list().map((entry) => entry["id"]);

        expect(ids).toEqual(["text", "aside", "quote"]);
    });

    test("adds at run time with the same checks, and the answered stop takes the entry out", async () =>
    {
        const kernel = await started([createEditor(), createQuotes()]);
        const blocks = kernel.context("quotes").registry("editor.blocks");

        const stop = blocks.set({ id: "draft", label: "Draft" });
        const whileSet = blocks.list().map((entry) => entry["id"]);
        stop();

        expect(whileSet).toEqual(["draft"]);
        expect(blocks.list()).toEqual([]);
        expect(() => blocks.set({ id: "bad" })).toThrow(/Registry "editor.blocks" refused an entry from "quotes": it does not match the entry schema/);
    });

    test("hides an entry from a caller lacking its permission, and from nobody signed in", async () =>
    {
        const kernel = await started([createEditor(), createQuotes({ adds: { "editor.blocks": [{ id: "table", label: "Table", requires: ["editor.advanced"] }, { id: "text", label: "Text" }] } })]);

        const granted = kernel.context("quotes", caller(["editor.advanced"])).registry("editor.blocks").list();
        const lacking = kernel.context("quotes", caller([])).registry("editor.blocks").list();
        const nobody = kernel.context("quotes").registry("editor.blocks").list();

        expect(granted.map((entry) => entry["id"])).toEqual(["table", "text"]);
        expect(lacking.map((entry) => entry["id"])).toEqual(["text"]);
        expect(nobody.map((entry) => entry["id"])).toEqual(["text"]);
    });

    test("is held by one kernel, never seen by another in the same process", async () =>
    {
        const first = await started([createEditor(), createQuotes()]);
        const second = await started([createEditor(), createQuotes()]);

        first.context("quotes").registry("editor.blocks").set({ id: "draft", label: "Draft" });

        expect(second.context("quotes").registry("editor.blocks").list()).toEqual([]);
    });
});

describe("a registry refuses", () =>
{
    test("at start, an entry to a registry no plugin declares, naming the fix", async () =>
    {
        const kernel = createKernel({ plugins: [createEditor(), createQuotes({ adds: { "editor.widgets": [{ id: "x" }] } })] });

        await expect(kernel.start()).rejects.toThrow(/Registry or pipeline "editor.widgets" is not declared by any plugin/);
    });

    test("at start, an addition from a plugin that does not depend on the owner", async () =>
    {
        const kernel = createKernel({ plugins: [createEditor(), createPlugin("stray", { adds: { "editor.blocks": [{ id: "x", label: "X" }] } })] });

        await expect(kernel.start()).rejects.toThrow(/belongs to "editor", which "stray" does not depend on/);
    });

    test("at start, an entry requiring a permission nobody declares", async () =>
    {
        const kernel = createKernel({ plugins: [createEditor(), createQuotes({ adds: { "editor.blocks": [{ id: "x", label: "X", requires: ["editor.nothing"] }] } })] });

        await expect(kernel.start()).rejects.toThrow(/Permission "editor.nothing" is not declared by any plugin/);
    });

    test("at start, every bad entry at once, and nothing is left half added", async () =>
    {
        const kernel = createKernel({ plugins: [createEditor({ reserved: ["core"] }), createQuotes({ adds: { "editor.blocks": [{ id: "core", label: "Core" }, { id: "", label: "Empty" }] } })] });

        const refused = await kernel.start().catch((error: unknown) => error);

        expect(refused).toMatchObject({ code: "INVALID_ENTRY", message: expect.stringContaining("2 entries stopped the kernel") });
        expect(String(refused)).toContain("\"core\" is reserved by \"editor\"");
        expect(kernel.started()).toBe(false);
    });

    test("a taken key, unless the owner lets a later entry replace it with a warning", async () =>
    {
        const strict = await started([createEditor(), createQuotes()]);
        const warned: string[] = [];
        const lenient = createKernel({ plugins: [createEditor({ replace: "warn" }), createQuotes()], log: (level, _plugin, line) => warned.push(`${level} ${line}`) });
        await lenient.start();

        strict.context("quotes").registry("editor.blocks").set({ id: "a", label: "One" });
        const first = lenient.context("editor").registry("editor.blocks").set({ id: "a", label: "One" });
        lenient.context("quotes").registry("editor.blocks").set({ id: "a", label: "Two" });
        first();

        expect(() => strict.context("quotes").registry("editor.blocks").set({ id: "a", label: "Two" })).toThrow(/"a" is already added by "quotes"/);
        expect(lenient.context("editor").registry("editor.blocks").list().map((entry) => entry["label"])).toEqual(["Two"]);
        expect(warned).toContain("warn registry \"editor.blocks\" replaced \"a\", added by \"editor\"");
    });

    test("past its cap, and from anyone but the owner when it says so", async () =>
    {
        const capped = await started([createEditor({ cap: 1 }), createQuotes()]);
        const closed = await started([createEditor({ set: "owner" }), createQuotes()]);

        capped.context("quotes").registry("editor.blocks").set({ id: "a", label: "A" });

        expect(() => capped.context("quotes").registry("editor.blocks").set({ id: "b", label: "B" })).toThrow(/holds its most, 1 entries/);
        expect(() => closed.context("quotes").registry("editor.blocks").set({ id: "b", label: "B" })).toThrow(/only "editor" may add to it/);
    });

    test("reaching a registry whose owner the plugin does not depend on", async () =>
    {
        const kernel = await started([createEditor(), createQuotes(), createPlugin("stray")]);

        expect(() => kernel.context("stray").registry("editor.blocks")).toThrow(/Add "editor" to dependsOn/);
    });

    test("a declaration without entry or key", async () =>
    {
        const kernel = createKernel({ plugins: [createPlugin("editor", { registries: { "editor.blocks": { describe: "Blocks." } as Registry } })] });

        await expect(kernel.start()).rejects.toThrow(/needs entry: z.object\(\{ \.\.\. \}\) and key/);
    });
});
