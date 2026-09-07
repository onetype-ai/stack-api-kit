import { describe, expect, test } from "vitest";
import { z } from "zod";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { definePlugin, defineRoute } from "../../kernel/api";
import { start } from "../api";

import type { Context } from "../../kernel/api";
import type { Store } from "../../database/api";

const route = defineRoute<Context>();

/** A site that keeps nothing: one route, no tables, nothing to migrate. */
const pages = definePlugin("pages", {
    version: "1.0.0",
    describe: "Answers without keeping anything.",
    routes: [
        route({
            method: "GET", path: "/hello", describe: "Says hello.", public: true,
            input: z.object({}), output: z.object({ hello: z.string() }),
            handle: () => ({ hello: "world" }),
        }),
    ],
});

const notes = sqliteTable("notes", { id: text("id").primaryKey() });

/** One that does keep rows, so it needs a database wherever it runs. */
const keeping = definePlugin("keeping", {
    version: "1.0.0",
    describe: "Keeps notes.",
    tables: { notes },
});

describe("a project with no tables at all", () =>
{
    test("starts without a word about databases", async () =>
    {
        const api = await start({ plugins: [pages] });

        const answer = await api.fetch(new Request("http://localhost/hello"));

        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ hello: "world" });

        await api.stop();
    });

    test("and stops without one either", async () =>
    {
        const api = await start({ plugins: [pages] });

        await expect(api.stop()).resolves.toBeUndefined();
    });
});

describe("a plugin that declares tables", () =>
{
    test("is refused by name when no database was given", async () =>
    {
        const failed = await start({ plugins: [pages, keeping] }).catch((cause: unknown) => cause);

        expect(failed).toBeInstanceOf(TypeError);
        expect((failed as Error).message).toContain('"keeping"');
        expect((failed as Error).message).toContain("no database");
    });

    test("and names every one of them, not just the first", async () =>
    {
        const second = definePlugin("archive", {
            version: "1.0.0",
            describe: "Keeps more notes.",
            tables: { archived: sqliteTable("archived", { id: text("id").primaryKey() }) },
        });

        const failed = await start({ plugins: [keeping, second] }).catch((cause: unknown) => cause);

        expect((failed as Error).message).toContain('"keeping"');
        expect((failed as Error).message).toContain('"archive"');
    });

    test("but runs once it has one", async () =>
    {
        const api = await start({ plugins: [keeping], database: { file: ":memory:" } });

        expect(api.kernel.started()).toBe(true);

        await api.stop();
    });
});

describe("reaching for a database nobody passed", () =>
{
    test("says what to pass, rather than throwing on undefined", async () =>
    {
        const reaching = definePlugin("reaching", {
            version: "1.0.0",
            describe: "Reaches ctx.db without declaring tables.",
            routes: [
                route({
                    method: "GET", path: "/rows", describe: "Reads.", public: true,
                    input: z.object({}), output: z.object({ ok: z.boolean() }),
                    handle: (_input, ctx) => ({ ok: ctx.db !== undefined }),
                }),
            ],
        });

        const api = await start({ plugins: [reaching] });

        const answer = await api.fetch(new Request("http://localhost/rows"));
        const body = await answer.json() as { code?: string };

        expect(answer.status).toBe(500);
        expect(body.code).toBe("INTERNAL");

        await api.stop();
    });
});

describe("a store that is not SQLite", () =>
{
    /** Whatever a project brought: Postgres, MySQL, or rows in a Map. */
    function elsewhere(): Store & { opened: number }
    {
        const held = new Map<string, unknown[]>();

        return {
            opened: 0,
            of: (plugin: string) => ({ rows: held.get(plugin) ?? [] }),
            tx: async (_plugin, run) => run({}),
            write: async (run) => run(),
            inTransaction: () => false,
            migrate: () => [],
            close: () => { held.clear(); },
        };
    }

    test("runs the api, and the kit never learns which one it got", async () =>
    {
        const reading = definePlugin("reading", {
            version: "1.0.0",
            describe: "Runs on whatever store the project brought.",
            routes: [
                route({
                    method: "GET", path: "/count", describe: "Counts.", public: true,
                    input: z.object({}), output: z.object({ count: z.number() }),
                    handle: (_input, ctx) => ({ count: (ctx.db as { rows: unknown[] }).rows.length }),
                }),
            ],
        });

        const api = await start({ plugins: [reading], database: elsewhere() });

        const answer = await api.fetch(new Request("http://localhost/count"));

        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ count: 0 });

        await api.stop();
    });

    test("is refused when it cannot migrate or close, naming both", async () =>
    {
        const half = { of: () => ({}), tx: async (_p: string, run: (db: unknown) => Promise<unknown>) => run({}) };

        const failed = await start({ plugins: [pages], database: half as unknown as Store })
            .catch((cause: unknown) => cause);

        expect(failed).toBeInstanceOf(TypeError);
        expect((failed as Error).message).toContain("migrate and close");
    });
});
