import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../index";
import { configureTestKernels, startTestKernel, withDependencies } from "../startTestKernel";

import type { Plugin } from "../../index";
import type { TestKernel } from "../startTestKernel";
import { column, table } from "../../plugins/database/api";
import { migrationsOf } from "../../plugins/database/tests/openStore";

const accounts = definePlugin("accounts", {
    version: "1.0.0",
    describe: "Holds accounts.",
    config: z.object({ region: z.string(), currency: z.string() }).strict(),
});

const catalog = definePlugin("catalog", { version: "1.0.0", describe: "Lists what is sold.", dependsOn: ["accounts"] });
const items = definePlugin("items", { version: "1.0.0", describe: "Holds items.", dependsOn: ["catalog", "accounts"] });

let api: TestKernel | undefined;
let asked = 0;

beforeEach(() =>
{
    asked = 0;

    configureTestKernels({
        resolve: () =>
        {
            asked += 1;

            return Promise.resolve({ plugins: [accounts, catalog, items], config: { accounts: { region: "eu", currency: "EUR" } } });
        },
    });
});

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

const namesOf = (plugins: readonly Plugin[]): string[] =>
{
    return plugins.map((plugin) => plugin.name);
};

describe("a kernel that names only the plugin under test", () =>
{
    test("boots with every plugin it depends on, each before the plugin that needs it", async () =>
    {
        const shop = definePlugin("shop", { version: "1.0.0", describe: "Sells items.", dependsOn: ["items"] });

        api = await startTestKernel({ plugins: [shop] });

        expect(api.kernel.started()).toBe(true);
        expect(namesOf(await withDependencies([shop]))).toEqual(["accounts", "catalog", "items", "shop"]);
    });

    test("adds each dependency once, however many plugins name it", async () =>
    {
        const names = namesOf(await withDependencies([items, catalog]));

        expect(names).toEqual(["accounts", "catalog", "items"]);
    });

    test("configures an added plugin from the fixture, under the test's own config field by field", async () =>
    {
        api = await startTestKernel({ plugins: [catalog], config: { accounts: { currency: "USD" } } });

        expect(api.kernel.context("accounts").config).toEqual({ region: "eu", currency: "USD" });
    });

    test("keeps exactly the config a test gave a plugin it passed, so a test proving that config wrong still sees it refused", async () =>
    {
        const booting = startTestKernel({ plugins: [accounts, catalog], config: { accounts: { region: "eu" } } });

        await expect(booting).rejects.toThrow();
    });

    test("keeps a stand-in the test passed over the discovered plugin of that name, and closes over its own dependencies", async () =>
    {
        const standIn = definePlugin("catalog", { version: "1.0.0", describe: "Lists nothing, for a test.", dependsOn: ["accounts"] });

        const plugins = await withDependencies([items, standIn]);

        expect(plugins).toContain(standIn);
        expect(plugins).not.toContain(catalog);
        expect(namesOf(plugins)).toEqual(["accounts", "catalog", "items"]);
    });

    test("refuses a dependency neither the test nor the fixture has, naming both ends and the fix", async () =>
    {
        const lonely = definePlugin("lonely", { version: "1.0.0", describe: "Needs what nobody ships.", dependsOn: ["nowhere"] });

        await expect(startTestKernel({ plugins: [lonely] })).rejects.toThrow("\"lonely\" depends on \"nowhere\", which the test did not pass and no discovered plugin is named. Pass a plugin named \"nowhere\"");
    });
});

describe("a kernel that passes everything it needs", () =>
{
    test("boots exactly as before, never asking for the fixture", async () =>
    {
        const standalone = definePlugin("standalone", { version: "1.0.0", describe: "Depends on nothing." });

        api = await startTestKernel({ plugins: [standalone] });

        expect(await withDependencies([standalone])).toEqual([standalone]);
        expect(asked).toBe(0);
    });
});

describe("a test kernel's outbox", () =>
{
    const notes = definePlugin("notes", {
        version: "1.0.0",
        describe: "Announces a note.",
        emits: { "notes.note.created": { describe: "A note was made.", schema: z.object({ id: z.string() }) } },
    });

    test("refuses an event emitted outside a transaction when asked for one, as a deployment with an outbox does", async () =>
    {
        const started = await startTestKernel({ plugins: [notes], outbox: true });

        api = started;

        expect(() => started.kernel.context("notes").events.emit("notes.note.created", { id: "1" })).toThrow("outside a transaction while an outbox is configured");
    });

    test("lets a plugin with no tables emit inside a transaction", async () =>
    {
        const started = await startTestKernel({ plugins: [notes], outbox: true });

        api = started;

        await started.kernel.context("notes").tx(async (inside) =>
        {
            inside.events.emit("notes.note.created", { id: "1" });
        });
        await started.flush();

        expect(started.emittedEvents()).toEqual([{ plugin: "notes", event: "notes.note.created", payload: { id: "1" } }]);
    });

    test("lets a test that means it run without one", async () =>
    {
        const started = await startTestKernel({ plugins: [notes], outbox: false });

        api = started;

        expect(() => started.kernel.context("notes").events.emit("notes.note.created", { id: "1" })).not.toThrow();
    });
});

describe("a fixture that loads plugins by name", () =>
{
    test("is asked only for the names missing, wave by wave, and each name once in a process", async () =>
    {
        const byName = new Map<string, Plugin>([accounts, catalog, items].map((plugin) => [plugin.name, plugin]));
        const waves: string[][] = [];

        configureTestKernels({
            resolve: (missing) =>
            {
                waves.push([...missing]);

                return Promise.resolve({ plugins: missing.flatMap((name) => byName.get(name) ?? []), config: { accounts: { region: "eu", currency: "EUR" } } });
            },
        });

        const shop = definePlugin("shop", { version: "1.0.0", describe: "Sells items.", dependsOn: ["items"] });

        api = await startTestKernel({ plugins: [shop] });
        await api.stop();
        api = await startTestKernel({ plugins: [shop] });

        expect(waves).toEqual([["items"], ["catalog", "accounts"]]);
        expect(api.kernel.context("accounts").config).toEqual({ region: "eu", currency: "EUR" });
    });
});

describe("defaults every test kernel in a process starts from", () =>
{
    const notes = definePlugin("notes", {
        version: "1.0.0",
        describe: "Announces a note.",
        emits: { "notes.note.created": { describe: "A note was made.", schema: z.object({ id: z.string() }) } },
    });

    test("apply where a test says nothing, and a test's own option wins", async () =>
    {
        configureTestKernels({ defaults: { outbox: true } });

        const defaulted = await startTestKernel({ plugins: [notes] });
        const refusing = (): void => defaulted.kernel.context("notes").events.emit("notes.note.created", { id: "1" });

        expect(refusing).toThrow("outside a transaction while an outbox is configured");
        await defaulted.stop();

        const overridden = await startTestKernel({ plugins: [notes], outbox: false });

        api = overridden;

        expect(() => overridden.kernel.context("notes").events.emit("notes.note.created", { id: "2" })).not.toThrow();
    });
});

describe("the scope a plugin acts in", () =>
{
    const scoped = definePlugin("rooms", { version: "1.0.0", describe: "Acts within a workspace.", scope: { describe: "A workspace's rooms.", claim: "workspace", tables: {} } });
    const unscoped = definePlugin("clock", { version: "1.0.0", describe: "Belongs to nobody." });

    test("still refuses a scope naming no table on a plugin that holds tables", async () =>
    {
        const holding = definePlugin("halls", {
            version: "1.0.0",
            describe: "Holds halls and scopes none.",
            tables: { halls: table("halls", { id: column.text("id").primaryKey(), workspace: column.text("workspace").notNull() }) },
            migrations: migrationsOf(`CREATE TABLE "halls" ("id" text PRIMARY KEY NOT NULL, "workspace" text NOT NULL);`),
            scope: { describe: "A workspace's halls.", claim: "workspace", tables: {} },
        });

        await expect(startTestKernel({ plugins: [holding] })).rejects.toThrow("A scope names no table");
    });

    test("is the caller's claim, what forScope named, or nothing", async () =>
    {
        const started = await startTestKernel({ plugins: [scoped, unscoped] });

        api = started;

        expect(started.kernel.context("rooms", { id: "u1", permissions: [], claims: { workspace: "w-1" } }).scope).toBe("w-1");
        expect(started.kernel.context("rooms").forScope("w-2").scope).toBe("w-2");
        expect(started.kernel.context("rooms").scope).toBeUndefined();
        expect(started.kernel.context("clock", { id: "u1", permissions: [], claims: { workspace: "w-1" } }).scope).toBeUndefined();
    });
});
