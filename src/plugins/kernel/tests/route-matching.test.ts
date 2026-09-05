import { describe, expect, test } from "vitest";
import { z } from "zod";

import Database from "better-sqlite3";

import { schedule } from "../../database/api";
import { createKernel, definePlugin } from "../api";

function startServer(): ReturnType<typeof createKernel>
{
    const people = definePlugin("people", {
        version: "1.0.0",
        describe: "Answers about one person.",
        routes: [
            {
                method: "GET",
                path: "/users/me",
                describe: "Who is asking.",
                input: z.object({}),
                output: z.object({ who: z.string() }),
                handle: () => ({ who: "closed" }),
            },
        ],
    });

    const anyone = definePlugin("public", {
        version: "1.0.0",
        describe: "Answers about anyone.",
        routes: [
            {
                method: "GET",
                path: "/users/:id",
                describe: "Anyone by name.",
                public: true,
                input: z.object({ id: z.string() }),
                output: z.object({ who: z.string() }),
                handle: (given: { id: string }) => ({ who: `public:${given.id}` }),
            },
        ],
    });

    return createKernel({ plugins: [people, anyone] });
}

describe("a path a caller wrote encoded", () =>
{
    // "%6de" is "me". Decoding only the parameter routes handed this to the
    // open one, past a route that was closed.
    test("reaches the route it spells, not the open one beside it", async () =>
    {
        const kernel = startServer();

        await kernel.start();

        const encoded = await kernel.handle({ method: "GET", path: "/users/%6de", input: {} });
        const plain = await kernel.handle({ method: "GET", path: "/users/me", input: {} });

        expect(encoded.status).toBe(plain.status);
        expect(encoded.body).toEqual(plain.body);

        await kernel.stop();
    });
});

describe("a name that lives on every object", () =>
{
    test("is not a command a plugin may schedule", async () =>
    {
        const refused: string[] = [];

        const billing = definePlugin("billing", {
            version: "1.0.0",
            describe: "Bills.",
            commands: { "billing.send": { describe: "Sends one.", schema: z.object({}), run: () => undefined } },
            setup: (ctx) =>
            {
                for (const name of ["constructor", "toString", "hasOwnProperty"])
                {
                    try
                    {
                        ctx.commands.later(name, {}, 60);
                    }
                    catch
                    {
                        refused.push(name);
                    }
                }
            },
        });

        const kernel = createKernel({ plugins: [billing], schedule: schedule(new Database(":memory:")) });

        await kernel.start();

        expect(refused).toEqual(["constructor", "toString", "hasOwnProperty"]);

        await kernel.stop();
    });

    test("and is not a table a plugin may scope", async () =>
    {
        const billing = definePlugin("billing", {
            version: "1.0.0",
            describe: "Bills.",
            tables: { invoices: {} },
            scope: { describe: "One shop.", claim: "shopId", tables: { invoices: "shopId" } },
            routes: [
                {
                    method: "GET",
                    path: "/billing/probe",
                    describe: "Asks to stamp a table nobody declared.",
                    input: z.object({}),
                    output: z.object({ logLines: z.string() }),
                    handle: (_given, ctx) => ({ logLines: JSON.stringify(ctx.stamped("toString")) }),
                },
            ],
        });

        const kernel = createKernel({ plugins: [billing] });

        await kernel.start();

        const answer = await kernel.handle({
            method: "GET",
            path: "/billing/probe",
            input: {},
            caller: { id: "one", claims: { shopId: "shop-1" }, permissions: [] },
        });

        expect(answer.status).toBe(500);

        await kernel.stop();
    });
});
