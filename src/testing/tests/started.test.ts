import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../index";
import { Started } from "../started";
import { startTestKernel } from "../startTestKernel";

import type { Plugin } from "../../index";
import type { TestKernel } from "../startTestKernel";

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

type RouteOptions = {
    requires?: readonly string[];

    /** Left out, the route carries a budget; `null` takes it away. */
    limit?: { requests: number; seconds: number } | null;
    reads?: readonly string[];
    public?: boolean;
};

function serving(name: string, route: RouteOptions = {}): Plugin
{
    return definePlugin(name, {
        version: "1.0.0",
        describe: `Serves ${name}.`,
        permissions: { [`${name}.read`]: { describe: `Read ${name}.` } },
        routes: [{
            method: "GET",
            path: `/${name}`,
            describe: "Answers.",
            requires: route.requires ?? [`${name}.read`],
            ...(route.public === undefined ? {} : { public: route.public }),
            ...(route.limit === null ? {} : { limit: route.limit ?? { requests: 10, seconds: 60 } }),
            ...(route.reads === undefined ? {} : { reads: route.reads }),
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handle: () => ({ ok: true }),
        }],
    });
}

describe("a closed route carrying no budget", () =>
{
    test("is reported, because one caller may spend the whole process on it", async () =>
    {
        api = await startTestKernel({ plugins: [serving("probe", { limit: null })] });

        const found = Started.findUnboundedRoutes(api.kernel);

        expect(found).toHaveLength(1);
        expect(found[0]?.check).toBe("unbounded");
        expect(found[0]?.message).toContain("GET /probe");
    });

    test("and left alone once carrying one, so a budgeted route is never a finding", async () =>
    {
        api = await startTestKernel({ plugins: [serving("probe")] });

        expect(Started.findUnboundedRoutes(api.kernel)).toEqual([]);
    });

    test("but left alone when it is named as meant, so a deliberate cost is not a finding", async () =>
    {
        api = await startTestKernel({ plugins: [serving("probe", { limit: null })] });

        expect(Started.findUnboundedRoutes(api.kernel, ["GET /probe"])).toEqual([]);
    });

    test("and excusing one route never excuses another", async () =>
    {
        api = await startTestKernel({
            plugins: [serving("probe", { limit: null }), serving("other", { limit: null })],
        });

        const found = Started.findUnboundedRoutes(api.kernel, ["GET /probe"]);

        expect(found).toHaveLength(1);
        expect(found[0]?.message).toContain("GET /other");
    });

    test("while a public route is left alone, since nothing was closed to begin with", async () =>
    {
        api = await startTestKernel({ plugins: [serving("probe", { limit: null, public: true, requires: [] })] });

        expect(Started.findUnboundedRoutes(api.kernel)).toEqual([]);
    });

    test("and a kernel carrying no plugin has nothing to say", async () =>
    {
        api = await startTestKernel({ plugins: [] });

        expect(Started.findAll(api.kernel)).toEqual([]);
    });
});

describe("what start already refuses, so no check here repeats it", () =>
{
    test("a permission no plugin declares stops the boot, rather than serving a route nothing can reach", async () =>
    {
        await expect(startTestKernel({ plugins: [serving("probe", { requires: ["nobody.grants"] })] }))
            .rejects.toThrow(/nobody\.grants/);
    });

    test("and a permission belonging to a plugin nobody depends on, which would be a hidden dependency", async () =>
    {
        await expect(startTestKernel({ plugins: [serving("probe", { requires: ["other.read"] }), serving("other")] }))
            .rejects.toThrow(/dependsOn/);
    });

    test("and a route reading a header that carries a credential", async () =>
    {
        await expect(startTestKernel({ plugins: [serving("probe", { reads: ["cookie"] })] }))
            .rejects.toThrow(/credential/);
    });
});

describe("a kernel carrying no plugin at all", () =>
{
    test("starts, so a stack with nothing in it is a stack rather than a fault", async () =>
    {
        api = await startTestKernel({ plugins: [] });

        expect(api.kernel.started()).toBe(true);
    });

    test("and declares no route, so the first one written is the first one there is", async () =>
    {
        api = await startTestKernel({ plugins: [] });

        expect(api.kernel.routes()).toEqual([]);
    });
});
