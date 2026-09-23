import { describe, expect, test } from "vitest";
import { z } from "zod";

import { declarationsOf } from "../api";
import { definePlugin } from "../../kernel/api";

const shop = definePlugin("shop", {
    version: "1.2.0",
    describe: "Sells things",
    dependsOn: ["catalogue"],
    config: z.object({ currency: z.string() }),
    tables: { orders: {}, carts: {} },
    scope: { describe: "one shop's rows", claim: "shopId", tables: { orders: "shop" } },
    allowedHosts: ["payments.example.com"],
    migrations: "./migrations",
    routes: [
        {
            method: "GET",
            path: "/shops",
            describe: "Lists shops",
            input: z.object({}),
            output: z.object({}),
            public: true,
            limit: { requests: 10, seconds: 60 },
            handle: () => ({}),
        },
        {
            method: "POST",
            path: "/shops",
            describe: "Creates a shop",
            input: z.object({}),
            output: z.object({}),
            requires: ["shop.write"],
            handle: () => ({}),
        },
    ],
    emits: { "shop.created": { describe: "A shop opened", schema: z.object({}) } },
    listens: { "catalogue.updated": { describe: "Re-prices", handle: () => {} } },
    commands: { "shop.archive": { describe: "Archives one", requires: ["shop.admin"], schema: z.object({}), run: () => {} } },
    setup: () => {},
});

const bare = definePlugin("bare", { version: "0.1.0", describe: "Declares nothing else" });

describe("declarationsOf", () =>
{
    test("reads every surface one plugin declares", () =>
    {
        const [declared] = declarationsOf([shop]);

        expect(declared?.name).toBe("shop");
        expect(declared?.version).toBe("1.2.0");
        expect(declared?.dependsOn).toEqual(["catalogue"]);
        expect(declared?.emits.map((each) => each.name)).toEqual(["shop.created"]);
        expect(declared?.listens.map((each) => each.name)).toEqual(["catalogue.updated"]);
        expect(declared?.tables).toEqual(["carts", "orders"]);
        expect(declared?.migrations).toBe("./migrations");
        expect(declared?.config).toBe(true);
        expect(declared?.teardown).toBe(false);
    });

    test("carries what a route asks of its caller", () =>
    {
        const [declared] = declarationsOf([shop]);
        const listing = declared?.routes.find((route) => route.method === "GET");
        const creating = declared?.routes.find((route) => route.method === "POST");

        expect(listing?.public).toBe(true);
        expect(listing?.limit).toEqual({ requests: 10, seconds: 60 });

        // a route that named neither reads the way the kernel treats it
        expect(creating?.public).toBe(false);
        expect(creating?.requires).toEqual(["shop.write"]);
        expect(creating?.limit).toBeUndefined();
    });

    test("names the claim a scope narrows by", () =>
    {
        const [declared] = declarationsOf([shop]);

        expect(declared?.scope?.claim).toBe("shopId");
        expect(declared?.scope?.tables).toEqual(["orders"]);
    });

    test("answers empty lists for a plugin declaring nothing", () =>
    {
        const [declared] = declarationsOf([bare]);

        expect(declared?.routes).toEqual([]);
        expect(declared?.emits).toEqual([]);
        expect(declared?.scope).toBeUndefined();
        expect(declared?.allowedHosts).toEqual([]);
        expect(declared?.setup).toBe(false);
    });

    test("narrows to one name, and sorts what it answers", () =>
    {
        expect(declarationsOf([shop, bare]).map((each) => each.name)).toEqual(["bare", "shop"]);
        expect(declarationsOf([shop, bare], "shop").map((each) => each.name)).toEqual(["shop"]);
    });

    test("answers nothing for a name no plugin carries", () =>
    {
        expect(declarationsOf([shop], "absent")).toEqual([]);
    });
});

describe("registries and pipelines", () =>
{
    const Item = z.object({ id: z.string() });
    const keep = (state: unknown): unknown => state;
    const posts = definePlugin("posts", {
        version: "1.0.0",
        describe: "Owns posts.",
        registries: { "posts.kinds": { describe: "Kinds of post.", entry: Item, key: "id" } },
        pipelines: { "posts.publish": { describe: "Publishes a post.", input: Item, output: Item, steps: [{ id: "validate", run: keep }, { id: "store", run: keep }] } },
    });
    const adder = (name: string, step: string) => definePlugin(name, {
        version: "1.0.0",
        describe: `The ${name} plugin.`,
        dependsOn: ["posts"],
        adds: { "posts.kinds": [{ id: `${name}-kind` }], "posts.publish": [{ id: step, after: "validate", run: keep }] },
    });

    test("reads a pipeline in the order start runs it, whatever order the plugins are handed in", () =>
    {
        const plugins = [adder("zeta", "last"), posts, adder("alpha", "first")];

        const forward = declarationsOf(plugins, "posts")[0]?.pipelines[0];
        const backward = declarationsOf([...plugins].reverse(), "posts")[0]?.pipelines[0];

        expect(forward).toMatchObject({ name: "posts.publish", problems: [] });
        expect(forward?.steps.map((step) => step.id)).toEqual(["validate", "first", "last", "store"]);
        expect(backward?.steps).toEqual(forward?.steps);
    });

    test("reads a registry with its key, and what each plugin adds", () =>
    {
        const [declared] = declarationsOf([posts, adder("alpha", "first")], "alpha");

        expect(declarationsOf([posts], "posts")[0]?.registries).toEqual([{ name: "posts.kinds", describe: "Kinds of post.", key: "id" }]);
        expect(declared?.adds).toEqual([{ registry: "posts.kinds", keys: ["alpha-kind"] }, { registry: "posts.publish", keys: ["first"] }]);
    });

    test("names what start would refuse, as the problems of the pipeline", () =>
    {
        const broken = definePlugin("broken", { version: "1.0.0", describe: "Anchors nowhere.", dependsOn: ["posts"], adds: { "posts.publish": [{ id: "x", after: "nowhere", run: keep }] } });

        const [declared] = declarationsOf([posts, broken], "posts");

        expect(declared?.pipelines[0]?.problems.join("\n")).toContain("sits beside \"nowhere\"");
    });
});
