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
