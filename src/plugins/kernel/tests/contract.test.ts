import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, KernelFault } from "../api";
import type { Definition, Plugin } from "../api";

/** A plugin with only what a case needs, and nothing that distracts from it. */
function made(name: string, found: Partial<Definition> = {}): Plugin
{
    return definePlugin(name, {
        version: "1.0.0",
        describe: `The ${name} plugin.`,
        ...found,
    } as Definition);
}

/** One route, with the parts every route must carry already filled in. */
function route(found: Partial<Definition["routes"] extends undefined ? never : NonNullable<Definition["routes"]>[number]> = {}): NonNullable<Definition["routes"]>[number]
{
    return {
        method: "GET",
        path: "/thing",
        describe: "Answers a thing.",
        input: z.object({}),
        output: z.object({}),
        handle: () => ({}),
        ...found,
    } as NonNullable<Definition["routes"]>[number];
}

/** Starts a kernel and answers what it refused, or undefined. */
async function refused(plugins: readonly Plugin[], config: Record<string, unknown> = {}): Promise<KernelFault | undefined>
{
    const kernel = createKernel({ plugins, config });

    try
    {
        await kernel.start();

        return undefined;
    }
    catch (cause)
    {
        return cause as KernelFault;
    }
}

describe("names", () =>
{
    test("refuses a plugin name that is not lowercase and hyphens", () =>
    {
        expect(() => made("Auth")).toThrow(KernelFault);
        expect(() => made("auth_plugin")).toThrow(/lowercase letters, digits and hyphens/);
    });

    test("names the character that broke the name", () =>
    {
        expect(() => made("auth plugin")).toThrow(/position 5/);
    });

    test("refuses an event outside the plugin's namespace, and says what to rename it to", async () =>
    {
        const failed = await refused([
            made("auth", { emits: { "session.ended": { describe: "gone", schema: z.object({}) } } }),
        ]);

        expect(failed?.code).toBe("INVALID_NAME");
        expect(failed?.message).toMatch(/belongs to "session", not to "auth"/);
        expect(failed?.message).toMatch(/auth\.ended/);
    });
});

describe("dependencies", () =>
{
    test("refuses a dependency no plugin provides", async () =>
    {
        const failed = await refused([made("billing", { dependsOn: ["missing"] })]);

        expect(failed?.code).toBe("UNKNOWN_DEPENDENCY");
        expect(failed?.message).toMatch(/"missing", which no plugin provides/);
    });

    test("refuses a cycle, naming the loop", async () =>
    {
        const failed = await refused([
            made("a", { dependsOn: ["b"] }),
            made("b", { dependsOn: ["a"] }),
        ]);

        expect(failed?.code).toBe("DEPENDENCY_CYCLE");
        expect(failed?.message).toMatch(/a -> b -> a|b -> a -> b/);
    });

    test("refuses two plugins with one name", async () =>
    {
        const failed = await refused([made("auth"), made("auth")]);

        expect(failed?.code).toBe("DUPLICATE_PLUGIN");
    });

    test("sets up a plugin after the ones it depends on", async () =>
    {
        const began: string[] = [];
        const kernel = createKernel({
            plugins: [
                made("billing", { dependsOn: ["auth"], setup: () => void began.push("billing") }),
                made("auth", { setup: () => void began.push("auth") }),
            ],
        });

        await kernel.start();

        expect(began).toEqual(["auth", "billing"]);
    });

    test("refuses reaching a plugin it does not depend on", async () =>
    {
        const kernel = createKernel({
            plugins: [made("auth", { services: () => ({ token: "x" }) }), made("billing")],
        });

        await kernel.start();

        expect(() => kernel.context("billing").use("auth")).toThrow(/Add "auth" to dependsOn/);
    });
});

describe("routes", () =>
{
    test("refuses two plugins declaring one route", async () =>
    {
        const failed = await refused([
            made("auth", { routes: [route({ path: "/x" })] }),
            made("billing", { routes: [route({ path: "/x" })] }),
        ]);

        expect(failed?.code).toBe("DUPLICATE_ROUTE");
        expect(failed?.message).toMatch(/already declared by "auth"/);
    });

    test("refuses two routes differing only in what they named a parameter", async () =>
    {
        const failed = await refused([
            made("auth", { routes: [route({ path: "/items/:id" }), route({ path: "/items/:key" })] }),
        ]);

        expect(failed?.code).toBe("DUPLICATE_ROUTE");
    });

    test("allows one path under two methods", async () =>
    {
        const failed = await refused([
            made("auth", { routes: [route({ method: "GET", path: "/x" }), route({ method: "POST", path: "/x" })] }),
        ]);

        expect(failed).toBeUndefined();
    });

    test("refuses a path in the wrong syntax", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ path: "items" })] })]);

        expect(failed?.code).toBe("INVALID_ROUTE");
        expect(failed?.message).toMatch(/must start with "\/"/);
    });

    test("refuses a path with an empty segment", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ path: "/items//x" })] })]);

        expect(failed?.code).toBe("INVALID_ROUTE");
        expect(failed?.message).toMatch(/empty segment/);
    });

    test("refuses a path with a segment outside what a path may hold", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ path: "/Items" })] })]);

        expect(failed?.code).toBe("INVALID_ROUTE");
    });

    test("takes a parameter named the way the code around it is", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ path: "/items/:documentId" })] })]);

        expect(failed).toBeUndefined();
    });

    test("still refuses a parameter that is not a name", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ path: "/items/:9lives" })] })]);

        expect(failed?.code).toBe("INVALID_ROUTE");
        expect(failed?.message).toMatch(/not letters and digits/);
    });

    test("still sees two paths differing only in a parameter's name as one", async () =>
    {
        const failed = await refused([
            made("auth", { routes: [route({ path: "/items/:documentId" }), route({ path: "/items/:noteId" })] }),
        ]);

        expect(failed?.code).toBe("DUPLICATE_ROUTE");
    });

    test("refuses a route that is public and also requires a permission", async () =>
    {
        const failed = await refused([
            made("auth", {
                permissions: { "auth.read": { describe: "Read." } },
                routes: [route({ public: true, requires: ["auth.read"] })],
            }),
        ]);

        expect(failed?.code).toBe("INVALID_ROUTE");
        expect(failed?.message).toMatch(/one or the other/);
    });

    test("refuses a route with no description", async () =>
    {
        const failed = await refused([made("auth", { routes: [route({ describe: "  " })] })]);

        expect(failed?.code).toBe("INVALID_ROUTE");
    });

    test("refuses a route needing a permission nothing declares", async () =>
    {
        const failed = await refused([made("billing", { routes: [route({ requires: ["billing.read"] })] })]);

        expect(failed?.code).toBe("UNDECLARED_PERMISSION");
    });
});

describe("declarations", () =>
{
    test("refuses two plugins claiming one table name", async () =>
    {
        const failed = await refused([
            made("auth", { tables: { users: {} } }),
            made("billing", { tables: { users: {} } }),
        ]);

        expect(failed?.code).toBe("DUPLICATE_TABLE");
    });

    test("refuses an outbound host that travels in the clear", async () =>
    {
        const failed = await refused([made("billing", { outbound: ["http://api.example.test"] })]);

        expect(failed?.code).toBe("UNDECLARED_HOST");
        expect(failed?.message).toMatch(/not encrypted/);
    });

    test("refuses an outbound host with no scheme at all", async () =>
    {
        const failed = await refused([made("billing", { outbound: ["api.example.test"] })]);

        expect(failed?.message).toMatch(/names no scheme/);
    });

    test("refuses an outbound host carrying a path", async () =>
    {
        const failed = await refused([made("billing", { outbound: ["https://api.example.test/v1/charges"] })]);

        expect(failed?.message).toMatch(/is not an origin/);
    });

    test("refuses a scheme the kit does not know", async () =>
    {
        const failed = await refused([made("billing", { outbound: ["gopher://api.example.test"] })]);

        expect(failed?.message).toMatch(/does not know/);
    });

    test("accepts the connections a plugin really opens, not only https", async () =>
    {
        const failed = await refused([made("billing", {
            outbound: ["redis://cache.internal:6379", "postgres://db.internal:5432", "wss://events.internal"],
        })]);

        expect(failed).toBeUndefined();
    });

    test("refuses a version that is not a version", async () =>
    {
        const failed = await refused([definePlugin("auth", { version: "banana", describe: "The auth plugin." })]);

        expect(failed?.code).toBe("INVALID_NAME");
    });

    test("refuses an empty description", async () =>
    {
        const failed = await refused([definePlugin("auth", { version: "1.0.0", describe: "  " })]);

        expect(failed?.message).toMatch(/describes itself in one sentence/);
    });

    test("reports every problem in one run rather than the first", async () =>
    {
        const failed = await refused([
            made("auth", { dependsOn: ["missing"] }),
            made("billing", { routes: [route({ path: "nope" })] }),
        ]);

        expect(failed?.message).toMatch(/2 problems/);
    });
});

describe("references", () =>
{
    test("refuses listening to an event nothing declares", async () =>
    {
        const failed = await refused([
            made("billing", { listens: { "auth.gone": { describe: "hears it", handle: () => {} } } }),
        ]);

        expect(failed?.code).toBe("UNDECLARED_EVENT");
    });

    test("lets a plugin hear an event without depending on its owner", async () =>
    {
        const failed = await refused([
            made("auth", { emits: { "auth.gone": { describe: "gone", schema: z.object({}) } } }),
            made("billing", { listens: { "auth.gone": { describe: "hears it", handle: () => {} } } }),
        ]);

        expect(failed).toBeUndefined();
    });

    test("lets two plugins hear each other, which no dependency order allows", async () =>
    {
        const failed = await refused([
            made("orders", {
                emits: { "orders.placed": { describe: "placed", schema: z.object({}) } },
                listens: { "payments.charged": { describe: "hears it", handle: () => {} } },
            }),
            made("payments", {
                emits: { "payments.charged": { describe: "charged", schema: z.object({}) } },
                listens: { "orders.placed": { describe: "hears it", handle: () => {} } },
            }),
        ]);

        expect(failed).toBeUndefined();
    });

    test("still refuses hearing an event nobody declares", async () =>
    {
        const failed = await refused([
            made("billing", { listens: { "auth.gone": { describe: "hears it", handle: () => {} } } }),
        ]);

        expect(failed?.code).toBe("UNDECLARED_EVENT");
    });

    test("still refuses calling a plugin it does not depend on", async () =>
    {
        const kernel = createKernel({
            plugins: [made("auth", { services: () => ({ token: "x" }) }), made("billing")],
        });

        await kernel.start();

        expect(() => kernel.context("billing").use("auth")).toThrow(/Add "auth" to dependsOn/);
    });

    test("still refuses a route requiring a permission it does not depend on", async () =>
    {
        const failed = await refused([
            made("auth", { permissions: { "auth.read": { describe: "Read." } } }),
            made("billing", { routes: [route({ requires: ["auth.read"] })] }),
        ]);

        expect(failed?.code).toBe("UNDECLARED_DEPENDENCY");
    });
});

describe("config", () =>
{
    test("refuses config that fails its schema, naming the key", async () =>
    {
        const failed = await refused(
            [made("billing", { config: z.object({ pageSize: z.number() }) })],
            { billing: { pageSize: "many" } },
        );

        expect(failed?.code).toBe("INVALID_CONFIG");
        expect(failed?.message).toMatch(/at "pageSize"/);
    });

    test("hands a plugin its own parsed config", async () =>
    {
        let seen: unknown;
        const kernel = createKernel({
            plugins: [made("billing", { config: z.object({ pageSize: z.number() }), setup: (ctx) => void (seen = ctx.config) })],
            config: { billing: { pageSize: 50 } },
        });

        await kernel.start();

        expect(seen).toEqual({ pageSize: 50 });
    });
});
