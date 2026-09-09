import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { startTestKernel, TestTables, createIdentity } from "../startTestKernel";

import type { Plugin } from "../../plugins/kernel/api";

const items = sqliteTable("note_items", { id: text("id").primaryKey() });

let at = "";

afterEach(() =>
{
    if (at !== "")
    {
        rmSync(at, { recursive: true, force: true });
        at = "";
    }
});

function createScheduled(): Plugin
{
    at = mkdtempSync(join(tmpdir(), "startTestKernel-"));

    writeFileSync(join(at, "0001-init.sql"), "CREATE TABLE note_items (id TEXT PRIMARY KEY)");

    return definePlugin("found", {
        version: "1.0.0",
        describe: "Holds items.",
        tables: { items },
        migrations: at,
        outbound: ["https://partner.test"],
        routes: [{
            method: "GET",
            path: "/found",
            describe: "Answers.",
            public: true,
            input: z.object({}),
            output: z.object({ ok: z.literal(true) }),
            limit: { requests: 5, seconds: 60 },
            handle: () => ({ ok: true as const }),
        }],
        setup: (ctx) =>
        {
            ctx.log.info("found ready");
        },
    });
}

describe("what startTestKernel gives a test", () =>
{
    test("opens a database from what the plugins declared", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()] });

        await expect(api.store.of("found").select().from(items)).resolves.toEqual([]);

        await api.stop();
    });

    test("runs the migrations the plugins named", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()] });

        await api.store.of("found").insert(items).values({ id: "a" });

        await expect(api.store.of("found").select().from(items)).resolves.toHaveLength(1);

        await api.stop();
    });

    test("keeps what each plugin said", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()] });

        expect(api.logLines).toMatchObject([{ level: "info", plugin: "found", line: "found ready" }]);

        await api.stop();
    });

    test("carries a budget, so a declared limit starts", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()] });

        const answers = [];

        for (let one = 0; one < 7; one += 1)
        {
            answers.push(await api.kernel.handle({ method: "GET", path: "/found", input: {}, from: "1.2.3.4" }));
        }

        expect(answers.filter((answer) => answer.status === 429)).toHaveLength(2);

        await api.stop();
    });

    test("records what a plugin called out to", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()], answers: () => ({ ok: true }) });

        await api.kernel.context("found").fetch({ method: "GET", url: "https://partner.test/x" });

        expect(api.outboundCalls()).toEqual([{
            method: "GET",
            url: "https://partner.test/x",
            body: undefined,
            headers: undefined,
        }]);

        await api.stop();
    });

    test("records the verb, so a test can tell a delete from a write", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()], answers: () => ({ ok: true }) });
        const ctx = api.kernel.context("found");

        await ctx.fetch({ method: "POST", url: "https://partner.test/things", body: { name: "one" } });
        await ctx.fetch({ method: "DELETE", url: "https://partner.test/things/1" });

        expect(api.outboundCalls().map((call) => `${call.method} ${call.url}`)).toEqual([
            "POST https://partner.test/things",
            "DELETE https://partner.test/things/1",
        ]);

        await api.stop();
    });

    test("records the headers a plugin sent", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()], answers: () => ({ ok: true }) });

        await api.kernel.context("found").fetch({
            method: "POST",
            url: "https://partner.test/x",
            headers: { "idempotency-key": "abc" },
        });

        expect(api.outboundCalls()[0]?.headers).toEqual({ "idempotency-key": "abc" });

        await api.stop();
    });

    test("records an event even when no plugin listens for it", async () =>
    {
        const announcing = definePlugin("announcing", {
            version: "1.0.0",
            describe: "Emits and nobody hears.",
            emits: { "announcing.done": { describe: "Done.", schema: z.object({ id: z.string() }) } },
        });

        const api = await startTestKernel({ plugins: [announcing] });

        api.kernel.context("announcing").events.emit("announcing.done", { id: "one" });

        expect(api.emittedEvents()).toEqual([{ plugin: "announcing", event: "announcing.done", payload: { id: "one" } }]);

        await api.stop();
    });

    test("records an event only once it has committed", async () =>
    {
        const announcing = definePlugin("announcing", {
            version: "1.0.0",
            describe: "Emits inside a transaction.",
            tables: { items },
            emits: { "announcing.done": { describe: "Done.", schema: z.object({ id: z.string() }) } },
        });

        const api = await startTestKernel({ plugins: [announcing] });

        await api.kernel.context("announcing").tx(async (inside) =>
        {
            inside.events.emit("announcing.done", { id: "rolled-back" });

            throw new Error("it rolled back");
        }).catch(() => undefined);

        expect(api.emittedEvents()).toEqual([]);

        await api.stop();
    });

    test("closes the database when it stops", async () =>
    {
        const api = await startTestKernel({ plugins: [createScheduled()] });

        await api.stop();

        expect(() => api.store.of("found")).toThrow(/after it was closed/);
    });
});

describe("reading a contract", () =>
{
    test("takes the tables and migrations off the plugins themselves", () =>
    {
        const plugin = createScheduled();

        expect(Object.keys(TestTables.tables([plugin]))).toEqual(["found"]);
        expect(TestTables.migrations([plugin])).toEqual([{ plugin: "found", from: at }]);
    });

    test("leaves out a plugin that declares no migrations", () =>
    {
        const quiet = definePlugin("quiet", { version: "1.0.0", describe: "Holds nothing." });

        expect(TestTables.migrations([quiet])).toEqual([]);
        expect(TestTables.tables([quiet])).toEqual({ quiet: {} });
    });
});

describe("a caller a test controls", () =>
{
    test("carries the permissions it was given", () =>
    {
        expect(createIdentity(["found.read"])).toMatchObject({ permissions: ["found.read"], claims: {} });
    });

    test("is one identity by default, so two tests do not share an id", () =>
    {
        expect(createIdentity().id).toBe(createIdentity().id);
        expect(createIdentity([], "u2").id).toBe("u2");
    });

    test("carries the claims a project decided a caller has", () =>
    {
        const scoped = createIdentity(["billing.read"], "u3", { tenantId: "acme" });

        expect(scoped.claims).toEqual({ tenantId: "acme" });
    });
});

describe("a caller whose permissions grants decided", () =>
{
    const guarded = definePlugin("guarded", {
        version: "1.0.0",
        describe: "Holds one closed route.",
        permissions: { "guarded.read": { describe: "Read it." } },
        routes: [{
            method: "GET" as const,
            path: "/guarded",
            describe: "Closed.",
            requires: ["guarded.read"],
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handle: () => ({ ok: true }),
        }],
    });

    function sessions(roles: Readonly<Record<string, readonly string[]>>): Plugin
    {
        return definePlugin("sessions", {
            version: "1.0.0",
            describe: "Says what a role holds.",
            mayGrant: ["guarded.read"],
            identifies: () => undefined,
            grants: (_ctx, who) => roles[String(who.claims["role"])] ?? [],
        });
    }

    test("asks the plugin that decides, rather than the test's own copy", async () =>
    {
        const api = await startTestKernel({ plugins: [sessions({ reader: ["guarded.read"], stranger: [] }), guarded] });

        const reader = await api.granted({ role: "reader" });
        const stranger = await api.granted({ role: "stranger" });

        expect(reader.permissions).toEqual(["guarded.read"]);
        expect(stranger.permissions).toEqual([]);
        expect(reader.claims).toEqual({ role: "reader" });

        await api.stop();
    });

    test("sees a role widened, which a written-out list cannot", async () =>
    {
        // The role table changed under the test: stranger now holds it too.
        const api = await startTestKernel({ plugins: [sessions({ stranger: ["guarded.read"] }), guarded] });

        const written = await api.kernel.handle({
            method: "GET", path: "/guarded", input: {},
            identity: createIdentity([], "u1", { role: "stranger" }),
        });
        const decided = await api.kernel.handle({
            method: "GET", path: "/guarded", input: {},
            identity: await api.granted({ role: "stranger" }),
        });

        expect(written.status).toBe(403);
        expect(decided.status).toBe(200);

        await api.stop();
    });

    test("says so where nothing grants, rather than answering an empty identity", async () =>
    {
        const api = await startTestKernel({ plugins: [guarded] });

        await expect(api.granted({ role: "reader" })).rejects.toThrow(/nothing decides/);

        await api.stop();
    });
});
