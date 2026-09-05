import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import type { Definition, Plugin, Storage } from "../api";

/**
 * A store a test drives, behaving the way the real one does: an inner call
 * becomes a savepoint rather than a second transaction, so only the outermost
 * one commits.
 */
function withStore(): Storage & { rolled: () => number; committed: () => number; saved: () => number }
{
    let rolled = 0;
    let committed = 0;
    let saved = 0;
    let depth = 0;

    return {
        of: (plugin) => ({ plugin }),

        tx: async (plugin, run) =>
        {
            const nested = depth > 0;

            depth += 1;

            try
            {
                const made = await run({ plugin, inTransaction: true });

                depth -= 1;
                nested ? (saved += 1) : (committed += 1);

                return made;
            }
            catch (cause)
            {
                depth -= 1;
                rolled += 1;

                throw cause;
            }
        },

        rolled: () => rolled,
        committed: () => committed,
        saved: () => saved,
    };
}

function participant(name: string, found: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, { version: "1.0.0", describe: `The ${name} plugin.`, ...found } as Definition);
}

describe("services", () =>
{
    test("builds them against the caller of this request, never the first one", async () =>
    {
        const kernel = createKernel({
            plugins: [participant("items", { services: (ctx) => ({ who: (): string | undefined => ctx.caller?.id }) })],
        });

        await kernel.start();

        const first = kernel.context("items", { id: "u1", permissions: [], claims: {} });
        const second = kernel.context("items", { id: "u2", permissions: [], claims: {} });

        expect((first.services as { who: () => string }).who()).toBe("u1");
        expect((second.services as { who: () => string }).who()).toBe("u2");
    });

    test("builds one plugin's services once per context, so state inside them holds", async () =>
    {
        let built = 0;
        const kernel = createKernel({
            plugins: [participant("items", {
                services: () =>
                {
                    built += 1;

                    return { count: (): number => built };
                },
            })],
        });

        await kernel.start();

        const ctx = kernel.context("items", { id: "u1", permissions: [], claims: {} });

        void ctx.services;
        void ctx.services;

        expect(built).toBe(1);
    });

    test("gives a dependency's services the same caller", async () =>
    {
        const kernel = createKernel({
            plugins: [
                participant("auth", { services: (ctx) => ({ who: (): string | undefined => ctx.caller?.id }) }),
                participant("billing", { dependsOn: ["auth"] }),
            ],
        });

        await kernel.start();

        const ctx = kernel.context("billing", { id: "u7", permissions: [], claims: {} });

        expect(ctx.use<{ who: () => string }>("auth").who()).toBe("u7");
    });
});

describe("events", () =>
{
    test("delivers to a listener in another plugin", async () =>
    {
        const recorded: unknown[] = [];
        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({ id: z.string() }) } } }),
                participant("billing", {
                    dependsOn: ["auth"],
                    listens: { "auth.gone": { describe: "Drops what it found.", handle: (payload) => void recorded.push(payload) } },
                }),
            ],
        });

        await kernel.start();

        kernel.context("auth").events.emit("auth.gone", { id: "u1" });

        expect(recorded).toEqual([{ id: "u1" }]);
    });

    test("refuses emitting an event another plugin owns", async () =>
    {
        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({}) } } }),
                participant("billing", { dependsOn: ["auth"] }),
            ],
        });

        await kernel.start();

        expect(() => kernel.context("billing").events.emit("auth.gone", {})).toThrow(/belongs to "auth"/);
    });

    test("refuses a payload failing the schema rather than delivering it", async () =>
    {
        const recorded: unknown[] = [];
        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({ id: z.string() }) } } }),
                participant("billing", {
                    dependsOn: ["auth"],
                    listens: { "auth.gone": { describe: "Hears it.", handle: (payload) => void recorded.push(payload) } },
                }),
            ],
        });

        await kernel.start();

        expect(() => kernel.context("auth").events.emit("auth.gone", { id: 7 })).toThrow(/does not match its schema/);
        expect(recorded).toEqual([]);
    });

    test("says so when a listener fails, rather than only recording it", async () =>
    {
        const lines: unknown[] = [];
        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({}) } } }),
                participant("billing", {
                    listens: {
                        "auth.gone": {
                            describe: "Fails asynchronously.",
                            handle: () => Promise.reject(new Error("the listener broke")),
                        },
                    },
                }),
            ],
            log: (level, plugin, line, about) =>
            {
                lines.push({ level, plugin, line, ...about });
            },
        });

        await kernel.start();

        kernel.context("auth").events.emit("auth.gone", {});

        await new Promise((keep) => setImmediate(keep));

        expect(kernel.events.failures()).toHaveLength(1);
        expect(lines).toMatchObject([{
            level: "error",
            plugin: "billing",
            line: 'listening to "auth.gone" failed',
            error: "the listener broke",
        }]);
    });

    test("keeps a throwing listener away from the emitter", async () =>
    {
        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({}) } } }),
                participant("billing", {
                    dependsOn: ["auth"],
                    listens: {
                        "auth.gone": {
                            describe: "Throws.",
                            handle: () =>
                            {
                                throw new Error("listener broke");
                            },
                        },
                    },
                }),
            ],
        });

        await kernel.start();

        expect(() => kernel.context("auth").events.emit("auth.gone", {})).not.toThrow();
        expect(kernel.events.failures()).toHaveLength(1);
    });

    test("hands a listener no caller, whoever emitted", async () =>
    {
        let seen: unknown = "never ran";

        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({}) } } }),
                participant("billing", {
                    dependsOn: ["auth"],
                    listens: {
                        "auth.gone": {
                            describe: "Records what it was given.",
                            handle: (_payload, ctx) => { seen = (ctx as { caller: unknown }).caller; },
                        },
                    },
                }),
            ],
        });

        await kernel.start();

        const who = { id: "u1", permissions: ["auth.read"], claims: { tenantId: "acme" } };

        kernel.context("auth", who).events.emit("auth.gone", {});

        await new Promise((keep) => setImmediate(keep));

        // Not the emitter's: an outbox keeps a payload, not a request, so a
        // listener that inherited one would answer differently after a
        // restart than before it.
        expect(seen).toBeUndefined();
    });

    test("keeps only the newest failures, so a listener that always throws cannot exhaust the process", async () =>
    {
        let thrown = 0;

        const kernel = createKernel({
            plugins: [
                participant("auth", { emits: { "auth.gone": { describe: "Session ended.", schema: z.object({}) } } }),
                participant("billing", {
                    dependsOn: ["auth"],
                    listens: {
                        "auth.gone": {
                            describe: "Throws every time.",
                            handle: () =>
                            {
                                thrown += 1;

                                throw new Error(`failure ${String(thrown)}`);
                            },
                        },
                    },
                }),
            ],
        });

        await kernel.start();

        const emitter = kernel.context("auth");

        for (let each = 0; each < 250; each += 1)
        {
            emitter.events.emit("auth.gone", {});
        }

        const kept = kernel.events.failures();
        const newest = kept.at(-1)?.error;

        expect(thrown).toBe(250);
        expect(kept).toHaveLength(100);
        expect(newest).toBeInstanceOf(Error);
        expect((newest as Error).message).toBe("failure 250");
    });
});

describe("transactions", () =>
{
    test("rolls back when the work throws", async () =>
    {
        const db = withStore();
        const kernel = createKernel({ plugins: [participant("items")], db });

        await kernel.start();

        await expect(kernel.context("items").tx(() => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
        expect(db.rolled()).toBe(1);
        expect(db.committed()).toBe(0);
    });

    test("holds an event until the transaction commits", async () =>
    {
        const recorded: unknown[] = [];
        const db = withStore();
        const kernel = createKernel({
            plugins: [
                participant("items", { emits: { "items.made": { describe: "An item was written.", schema: z.object({}) } } }),
                participant("audit", {
                    dependsOn: ["items"],
                    listens: { "items.made": { describe: "Records it.", handle: () => void recorded.push("recorded") } },
                }),
            ],
            db,
        });

        await kernel.start();

        const ctx = kernel.context("items");

        await ctx.tx(async (inside) =>
        {
            inside.events.emit("items.made", {});

            expect(recorded).toEqual([]);

            return undefined;
        });

        expect(recorded).toEqual(["recorded"]);
    });

    test("never delivers an event from a transaction that rolled back", async () =>
    {
        const recorded: unknown[] = [];
        const db = withStore();
        const kernel = createKernel({
            plugins: [
                participant("items", { emits: { "items.made": { describe: "An item was written.", schema: z.object({}) } } }),
                participant("audit", {
                    dependsOn: ["items"],
                    listens: { "items.made": { describe: "Records it.", handle: () => void recorded.push("recorded") } },
                }),
            ],
            db,
        });

        await kernel.start();

        const ctx = kernel.context("items");

        await expect(ctx.tx(async (inside) =>
        {
            inside.events.emit("items.made", {});

            throw new Error("write failed");
        })).rejects.toThrow("write failed");

        expect(recorded).toEqual([]);
    });

    test("holds an event emitted on the outer context, not just the one tx handed over", async () =>
    {
        const recorded: unknown[] = [];
        const db = withStore();
        const kernel = createKernel({
            plugins: [
                participant("items", { emits: { "items.made": { describe: "Written.", schema: z.object({}) } } }),
                participant("audit", {
                    dependsOn: ["items"],
                    listens: { "items.made": { describe: "Records it.", handle: () => void recorded.push("recorded") } },
                }),
            ],
            db,
        });

        await kernel.start();

        const ctx = kernel.context("items");

        await expect(ctx.tx(async () =>
        {
            // The easy mistake: the outer ctx, not the one tx handed over.
            ctx.events.emit("items.made", {});

            throw new Error("the write failed");
        })).rejects.toThrow("the write failed");

        expect(recorded).toEqual([]);
    });

    test("keeps an inner transaction's events and drops the ones it rolled back", async () =>
    {
        const recorded: string[] = [];
        const db = withStore();
        const kernel = createKernel({
            plugins: [
                participant("items", {
                    emits: {
                        "items.made": { describe: "Written.", schema: z.object({ id: z.string() }) },
                    },
                }),
                participant("audit", {
                    dependsOn: ["items"],
                    listens: {
                        "items.made": {
                            describe: "Records it.",
                            handle: (payload) => void recorded.push((payload as { id: string }).id),
                        },
                    },
                }),
            ],
            db,
        });

        await kernel.start();

        const ctx = kernel.context("items");

        await ctx.tx(async (outer) =>
        {
            outer.events.emit("items.made", { id: "outer" });

            await outer.tx(async (inner) =>
            {
                inner.events.emit("items.made", { id: "kept" });
            });

            await outer.tx(async (inner) =>
            {
                inner.events.emit("items.made", { id: "dropped" });

                throw new Error("the inner work failed");
            }).catch(() => undefined);
        });

        expect(recorded).toEqual(["outer", "kept"]);
    });

    test("still refuses a bad payload inside a transaction, where it was written", async () =>
    {
        const db = withStore();
        const kernel = createKernel({
            plugins: [participant("items", { emits: { "items.made": { describe: "Written.", schema: z.object({ id: z.string() }) } } })],
            db,
        });

        await kernel.start();

        const ctx = kernel.context("items");

        await expect(ctx.tx((inside) =>
        {
            inside.events.emit("items.made", { id: 7 });

            return Promise.resolve();
        })).rejects.toThrow(/does not match its schema/);
    });

    test("joins an inner transaction to the outer one rather than opening a second", async () =>
    {
        const db = withStore();
        const kernel = createKernel({ plugins: [participant("items")], db });

        await kernel.start();

        const ctx = kernel.context("items");

        await ctx.tx(async (inside) =>
        {
            await inside.tx(() => Promise.resolve("inner"));

            return "outer";
        });

        expect(db.committed()).toBe(1);
        expect(db.saved()).toBe(1);
    });

    test("refuses a transaction when no store was given, naming what to pass", async () =>
    {
        const kernel = createKernel({ plugins: [participant("items")] });

        await kernel.start();

        expect(() => kernel.context("items").db).toThrow(/Pass `db` to createKernel/);
    });
});

describe("outbound", () =>
{
    test("refuses a host the plugin never declared", async () =>
    {
        const kernel = createKernel({
            plugins: [participant("billing", { outbound: ["https://api.stripe.com"] })],
            dial: () => Promise.resolve({}),
        });

        await kernel.start();

        // Rejects rather than throws: a caller guarding with `.catch()` must
        // catch the refusal too.
        await expect(kernel.context("billing").fetch({ method: "GET", url: "https://evil.test/steal" }))
            .rejects.toThrow(/does not declare/);
    });

    test("allows a host it declared", async () =>
    {
        const dialled: string[] = [];
        const kernel = createKernel({
            plugins: [participant("billing", { outbound: ["https://api.stripe.com"] })],
            dial: (call) =>
            {
                dialled.push(call.url);

                return Promise.resolve({ ok: true });
            },
        });

        await kernel.start();

        await expect(kernel.context("billing").fetch({ method: "GET", url: "https://api.stripe.com/v1/charges" }))
            .resolves.toEqual({ ok: true });
        expect(dialled).toEqual(["https://api.stripe.com/v1/charges"]);
    });

    test("refuses a url whose host only looks like one it declared", async () =>
    {
        const kernel = createKernel({
            plugins: [participant("billing", { outbound: ["https://api.stripe.com"] })],
            dial: () => Promise.resolve({}),
        });

        await kernel.start();

        await expect(kernel.context("billing").fetch({ method: "GET", url: "https://api.stripe.com.evil.test/x" }))
            .rejects.toThrow(/does not declare/);
    });

    test("refuses plain http even to a declared host", async () =>
    {
        const kernel = createKernel({
            plugins: [participant("billing", { outbound: ["https://api.stripe.com"] })],
            dial: () => Promise.resolve({}),
        });

        await kernel.start();

        await expect(kernel.context("billing").fetch({ method: "GET", url: "http://api.stripe.com/x" }))
            .rejects.toThrow(/does not declare/);
    });
});
