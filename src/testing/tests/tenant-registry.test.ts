import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { ChannelMessage, Context, Definition, Identity, Plugin, Registry } from "../../index";
import type { TestKernel } from "../startTestKernel";

const Block = z.object({ id: z.string(), label: z.string(), order: z.number().optional(), requires: z.array(z.string()).optional() });

function createEditor(registry: Partial<Registry> = {}, definition: Partial<Definition> = {}): Plugin
{
    return definePlugin("editor", {
        version: "1.0.0",
        describe: "Owns the blocks a page is built from.",
        permissions: { "editor.use": { describe: "Uses the editor." }, "editor.admin": { describe: "Runs the editor." } },
        scope: { describe: "One workspace's blocks.", claim: "workspace", tables: {} },
        registries: { "editor.blocks": { describe: "Blocks a page is built from.", entry: Block, key: "id", scope: "tenant", expose: { requires: ["editor.use"] }, ...registry } },
        ...definition,
    } as Definition);
}

const quotes = definePlugin("quotes", { version: "1.0.0", describe: "Adds quote blocks.", dependsOn: ["editor"] } as Definition);

const member = (workspace: string, permissions: string[] = ["editor.use"]): Identity => ({ id: `${workspace}-member`, permissions, claims: { workspace } });

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

async function set(kernel: TestKernel, who: Identity, entry: unknown): Promise<void>
{
    await kernel.kernel.context("quotes", who).tx(async (inside) => inside.scopedRegistry("editor.blocks").set(entry));
}

describe("a tenant registry", () =>
{
    test("lists what one scope set, after what plugins add for every scope, and never another scope's", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor({}, { adds: { "editor.blocks": [{ id: "text", label: "Text", order: 1 }] } }), quotes], outbox: true });
        await set(api, member("a"), { id: "quote", label: "Quote", order: 2 });

        const inA = await api.kernel.context("quotes", member("a")).scopedRegistry("editor.blocks").list();
        const inB = await api.kernel.context("quotes", member("b")).scopedRegistry("editor.blocks").list();

        expect(inA.map((entry) => entry["id"])).toEqual(["text", "quote"]);
        expect(inB.map((entry) => entry["id"])).toEqual(["text"]);
    });

    test("keeps nothing a rolled-back transaction set, and announces nothing", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        const who = member("a");

        const failed = api.kernel.context("quotes", who).tx(async (inside) =>
        {
            await inside.scopedRegistry("editor.blocks").set({ id: "draft", label: "Draft" });

            throw new Error("the work failed");
        });

        await expect(failed).rejects.toThrow("the work failed");
        await api.flush();
        expect(await api.kernel.context("quotes", who).scopedRegistry("editor.blocks").snapshot()).toEqual({ version: 0, entries: [] });
        expect(api.emittedEvents().filter((seen) => seen.event === "editor.blocks.changed")).toEqual([]);
    });

    test("announces each change with its version and the permissions it moved between, never the entry", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        const who = member("a");

        await set(api, who, { id: "draft", label: "Draft" });
        await set(api, who, { id: "draft", label: "Draft", requires: ["editor.admin"] });
        await api.kernel.context("quotes", who).tx(async (inside) => inside.scopedRegistry("editor.blocks").remove("draft"));
        await api.flush();

        const changes = api.emittedEvents().filter((seen) => seen.event === "editor.blocks.changed").map((seen) => seen.payload);

        expect(changes).toEqual([
            { op: "set", key: "draft", version: 1, scope: "a", requires: [] },
            { op: "set", key: "draft", version: 2, scope: "a", requires: ["editor.admin"], before: [] },
            { op: "remove", key: "draft", version: 3, scope: "a", requires: [], before: ["editor.admin"] },
        ]);
        expect(JSON.stringify(changes)).not.toContain("Draft");
    });

    test("hides an entry from a caller lacking its permission", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        await set(api, member("a"), { id: "table", label: "Table", requires: ["editor.admin"] });

        const admin = await api.kernel.context("quotes", member("a", ["editor.use", "editor.admin"])).scopedRegistry("editor.blocks").list();
        const plain = await api.kernel.context("quotes", member("a")).scopedRegistry("editor.blocks").list();

        expect(admin.map((entry) => entry["id"])).toEqual(["table"]);
        expect(plain).toEqual([]);
    });
});

describe("a test kernel after another stopped", () =>
{
    test("starts from nothing the other wrote: no entry, no version, no event", async () =>
    {
        const first = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        await set(first, member("a"), { id: "quote", label: "Quote" });
        await first.stop();

        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        await set(api, member("a"), { id: "table", label: "Table" });
        await api.flush();

        expect(await api.kernel.context("quotes", member("a")).scopedRegistry("editor.blocks").snapshot()).toEqual({ version: 1, entries: [{ id: "table", label: "Table" }] });
        expect(api.emittedEvents().map((seen) => seen.payload)).toEqual([{ op: "set", key: "table", version: 1, scope: "a", requires: [] }]);
    });
});

describe("a tenant registry's snapshot route", () =>
{
    test("answers this caller's scope and version, without what it may not see", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });
        await set(api, member("a"), { id: "quote", label: "Quote" });
        await set(api, member("a"), { id: "table", label: "Table", requires: ["editor.admin"] });

        const inA = await api.kernel.handle({ method: "GET", path: "/registries/editor.blocks", input: {}, identity: member("a") });
        const inB = await api.kernel.handle({ method: "GET", path: "/registries/editor.blocks", input: {}, identity: member("b") });

        expect(inA).toMatchObject({ status: 200, body: { version: 2, entries: [{ id: "quote", label: "Quote" }] } });
        expect(inB).toMatchObject({ status: 200, body: { version: 0, entries: [] } });
    });

    test("refuses a caller lacking expose.requires, and one signed out", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });

        const lacking = await api.kernel.handle({ method: "GET", path: "/registries/editor.blocks", input: {}, identity: member("a", []) });
        const nobody = await api.kernel.handle({ method: "GET", path: "/registries/editor.blocks", input: {} });

        expect(lacking.status).toBe(403);
        expect(nobody.status).toBe(401);
    });
});

describe("a tenant registry refuses", () =>
{
    test("a change outside a transaction, naming ctx.tx", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true });

        const outside = api.kernel.context("quotes", member("a")).scopedRegistry("editor.blocks").set({ id: "x", label: "X" });

        await expect(outside).rejects.toMatchObject({ code: "UNKEPT_ENTRY", message: expect.stringContaining("inside ctx.tx") });
    });

    test("a caller in no scope, and a key a plugin adds for every scope", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor({}, { adds: { "editor.blocks": [{ id: "text", label: "Text" }] } }), quotes], outbox: true });

        expect(() => api?.kernel.context("quotes").scopedRegistry("editor.blocks")).toThrow(/UNSCOPED_CALLER|where nobody is calling/);
        await expect(set(api, member("a"), { id: "text", label: "Mine" })).rejects.toThrow(/added for every scope/);
    });

    test("past its cap in one scope, while another scope still has room", async () =>
    {
        api = await startTestKernel({ plugins: [createEditor({ cap: 1 }), quotes], outbox: true });
        await set(api, member("a"), { id: "one", label: "One" });

        await expect(set(api, member("a"), { id: "two", label: "Two" })).rejects.toThrow(/holds its most, 1 entries in this scope/);
        await expect(set(api, member("b"), { id: "two", label: "Two" })).resolves.toBeUndefined();
    });

    test("being reached through the other accessor, naming the right one", async () =>
    {
        const statics = definePlugin("menus", { version: "1.0.0", describe: "Menus.", registries: { "menus.items": { describe: "Items.", entry: Block, key: "id" } } } as Definition);
        api = await startTestKernel({ plugins: [createEditor(), quotes, statics], outbox: true });

        expect(() => api?.kernel.context("quotes", member("a")).registry("editor.blocks")).toThrow(/Use ctx.scopedRegistry\("editor.blocks"\)/);
        expect(() => api?.kernel.context("menus", member("a")).scopedRegistry("menus.items")).toThrow(/Use ctx.registry\("menus.items"\)/);
    });

    test("at start, a tenant registry whose owner declares no scope, and a route under /registries/", async () =>
    {
        const unscoped = definePlugin("editor", { version: "1.0.0", describe: "Blocks.", registries: { "editor.blocks": { describe: "Blocks.", entry: Block, key: "id", scope: "tenant" } } } as Definition);
        const squatter = definePlugin("squatter", { version: "1.0.0", describe: "Takes a kit path.", routes: [defineRoute<Context>()({ method: "GET", path: "/registries/mine", describe: "Mine.", public: true, input: z.object({}), output: z.object({}), handle: () => ({}) })] });

        await expect(startTestKernel({ plugins: [unscoped] })).rejects.toThrow(/declares no scope/);
        await expect(startTestKernel({ plugins: [squatter] })).rejects.toThrow(/under \/registries\/, where the kit serves/);
    });
});

/** What a socket holding these permissions hears of one push: the first variant it may, else the message. */
function heardBy(push: ChannelMessage, permissions: readonly string[]): unknown
{
    return (push.variants ?? []).find((variant) => variant.requires.every((one) => permissions.includes(one)))?.message ?? push.message;
}

describe("a tenant registry's pushes", () =>
{
    const plain = ["editor.use"];
    const admin = ["editor.use", "editor.admin"];

    async function pushedAfter(changes: (inside: Context) => Promise<unknown>): Promise<ChannelMessage[]>
    {
        api = await startTestKernel({ plugins: [createEditor(), quotes], outbox: true, sockets: true });

        await api.kernel.context("quotes", member("a")).tx(async (inside) => changes(inside));
        await api.flush();

        return pushesOf(api);
    }

    // pushes of one commit are delivered side by side, so a test finds each by its version, never by its place
    function pushesOf(kernel: TestKernel | undefined): ChannelMessage[]
    {
        const versionOf = (push: ChannelMessage): number => (push.message as { version: number }).version;

        return (kernel?.pushed() ?? []).filter((push) => push.channel === "registry.editor.blocks").sort((first, second) => versionOf(first) - versionOf(second));
    }

    test("stay in the scope of the change, held to expose.requires", async () =>
    {
        const [push] = await pushedAfter((inside) => inside.scopedRegistry("editor.blocks").set({ id: "quote", label: "Quote" }));

        expect(push).toMatchObject({ reach: "scope", scope: "a", requires: ["editor.use"] });
        expect(heardBy(push!, plain)).toEqual({ version: 1, op: "set", key: "quote", entry: { id: "quote", label: "Quote" } });
    });

    test("take an entry away from a viewer whose permission it no longer matches, and give it to one it now does", async () =>
    {
        const pushes = await pushedAfter(async (inside) =>
        {
            await inside.scopedRegistry("editor.blocks").set({ id: "draft", label: "Draft", requires: ["editor.admin"] });
            await inside.scopedRegistry("editor.blocks").set({ id: "other", label: "Other" });
        });
        await api?.kernel.context("quotes", member("a")).tx(async (inside) =>
        {
            await inside.scopedRegistry("editor.blocks").set({ id: "other", label: "Other", requires: ["editor.admin"] });
            await inside.scopedRegistry("editor.blocks").set({ id: "draft", label: "Draft" });
        });
        await api?.flush();
        const [tightened, loosened] = pushesOf(api).slice(pushes.length);

        expect(heardBy(tightened!, plain)).toEqual({ version: 3, op: "remove", key: "other" });
        expect(heardBy(tightened!, admin)).toMatchObject({ version: 3, op: "set", key: "other" });
        expect(heardBy(loosened!, plain)).toEqual({ version: 4, op: "set", key: "draft", entry: { id: "draft", label: "Draft" } });
    });

    test("tell a removal only to viewers who could see the entry, and a skip to the rest", async () =>
    {
        const pushes = await pushedAfter(async (inside) =>
        {
            await inside.scopedRegistry("editor.blocks").set({ id: "table", label: "Table", requires: ["editor.admin"] });
            await inside.scopedRegistry("editor.blocks").remove("table");
        });
        const removal = pushes[1]!;

        expect(heardBy(removal, admin)).toEqual({ version: 2, op: "remove", key: "table" });
        expect(heardBy(removal, plain)).toEqual({ version: 2, op: "skip" });
        expect(JSON.stringify(heardBy(pushes[0]!, plain))).not.toContain("table");
    });

    test("skip an entry changed again before its push, which the later change sends under its own permissions", async () =>
    {
        const pushes = await pushedAfter(async (inside) =>
        {
            await inside.scopedRegistry("editor.blocks").set({ id: "draft", label: "Open" });
            await inside.scopedRegistry("editor.blocks").set({ id: "draft", label: "Secret", requires: ["editor.admin"] });
        });

        expect(heardBy(pushes[0]!, plain)).toEqual({ version: 1, op: "skip" });
        expect(JSON.stringify(pushes[0])).not.toContain("Secret");
        expect(heardBy(pushes[1]!, plain)).toEqual({ version: 2, op: "remove", key: "draft" });
    });
});

describe("an exposed static registry", () =>
{
    test("answers what plugins add at version 0, and refuses a runtime set", async () =>
    {
        const menus = definePlugin("menus", {
            version: "1.0.0",
            describe: "Menus.",
            permissions: { "menus.read": { describe: "Reads menus." } },
            registries: { "menus.items": { describe: "Items.", entry: Block, key: "id", expose: { requires: ["menus.read"] } } },
            adds: { "menus.items": [{ id: "home", label: "Home" }] },
        } as Definition);
        api = await startTestKernel({ plugins: [menus] });
        const reader: Identity = { id: "r", permissions: ["menus.read"], claims: {} };

        const snapshot = await api.kernel.handle({ method: "GET", path: "/registries/menus.items", input: {}, identity: reader });

        expect(snapshot).toMatchObject({ status: 200, body: { version: 0, entries: [{ id: "home", label: "Home" }] } });
        expect(() => api?.kernel.context("menus", reader).registry("menus.items").set({ id: "x", label: "X" })).toThrow(/exposed to the app/);
    });
});
