import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import type { Definition, Plugin } from "../api";

const SECRET = { id: "u1", email: "a@b.test", passwordHash: "$2b$LEAK", totpSecret: "LEAK2" };

function startServer(output: z.ZodType): Plugin
{
    return definePlugin("probe", {
        version: "1.0.0",
        describe: "Answers a row.",
        routes: [{
            method: "GET",
            path: "/me",
            describe: "Answers the caller.",
            public: true,
            input: z.object({}),
            output,
            handle: () => SECRET,
        }],
    } as Definition);
}

async function refusalFor(output: z.ZodType): Promise<string | undefined>
{
    const kernel = createKernel({ plugins: [startServer(output)] });

    try
    {
        await kernel.start();

        return undefined;
    }
    catch (cause)
    {
        return (cause as Error).message;
    }
}

describe("an output schema that cannot filter is refused at startup", () =>
{
    const open: [string, z.ZodType][] = [
        ["z.any()", z.any()],
        ["z.unknown()", z.unknown()],
        ["a loose object", z.looseObject({ id: z.string() })],
        ["an object with a catchall", z.object({ id: z.string() }).catchall(z.unknown())],
        ["a record", z.record(z.string(), z.unknown())],
        ["a transform", z.object({ id: z.string() }).transform((found) => found)],
        ["a nested any", z.object({ id: z.string(), meta: z.any() })],
        ["an array of any", z.array(z.any())],
        ["a union with one open member", z.union([z.object({ id: z.string() }), z.any()])],
    ];

    for (const [what, schema] of open)
    {
        test(`refuses ${what}`, async () =>
        {
            const message = await refusalFor(schema);

            expect(message).toMatch(/cannot filter what leaves/);
        });
    }
});

describe("an output schema that filters is accepted", () =>
{
    const closed: [string, z.ZodType][] = [
        ["a strict object", z.object({ id: z.string() })],
        ["a nested object", z.object({ item: z.object({ id: z.string() }) })],
        ["an array of objects", z.object({ items: z.array(z.object({ id: z.string() })) })],
        ["optional and nullable fields", z.object({ id: z.string().optional(), at: z.string().nullable() })],
        ["a union of objects", z.union([z.object({ id: z.string() }), z.object({ error: z.string() })])],
        ["an enum and a literal", z.object({ status: z.enum(["a", "b"]), ok: z.literal(true) })],
        ["a defaulted field", z.object({ page: z.number().default(1) })],
        ["a strict object, whose catchall keeps nothing", z.strictObject({ id: z.string() })],
    ];

    for (const [what, schema] of closed)
    {
        test(`accepts ${what}`, async () =>
        {
            expect(await refusalFor(schema)).toBeUndefined();
        });
    }
});

describe("a recursive schema", () =>
{
    type Block = { id: string; children: Block[] };

    const Block: z.ZodType<Block> = z.lazy(() =>
        z.object({ id: z.string(), children: z.array(Block) }));

    test("is accepted, because it filters at every level", async () =>
    {
        expect(await refusalFor(Block)).toBeUndefined();
    });

    test("strips an unnamed field however deep it sits", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("probe", {
                version: "1.0.0",
                describe: "Answers a tree.",
                routes: [{
                    method: "GET",
                    path: "/tree",
                    describe: "Answers a block tree.",
                    public: true,
                    input: z.object({}),
                    output: Block,
                    handle: () => ({
                        id: "root",
                        secret: "LEAK",
                        children: [{ id: "a", secret: "LEAK", children: [{ id: "b", secret: "LEAK", children: [] }] }],
                    }),
                }],
            } as Definition)],
        });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/tree", input: {} });

        expect(JSON.stringify(answer.body)).not.toMatch(/LEAK/);
        expect(answer.body).toEqual({
            id: "root",
            children: [{ id: "a", children: [{ id: "b", children: [] }] }],
        });
    });

    test("still refuses a recursive shape that holds an open field", async () =>
    {
        type Loose = { id: string; meta: unknown; children: Loose[] };

        const Loose: z.ZodType<Loose> = z.lazy(() =>
            z.object({ id: z.string(), meta: z.any(), children: z.array(Loose) }));

        expect(await refusalFor(Loose)).toMatch(/cannot filter what leaves/);
    });
});

describe("the message it gives when a schema cannot filter", () =>
{
    test("names a construct that actually works", async () =>
    {
        const message = await refusalFor(z.any());

        expect(message).toMatch(/Use z\.object naming every field/);

        // The advice has to be advice: whatever it names must pass.
        expect(await refusalFor(z.object({ id: z.string() }))).toBeUndefined();
    });
});

describe("what a filtering schema actually sends", () =>
{
    test("drops every field the schema does not name", async () =>
    {
        const kernel = createKernel({ plugins: [startServer(z.object({ id: z.string() }))] });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/me", input: {} });

        expect(answer.body).toEqual({ id: "u1" });
        expect(JSON.stringify(answer.body)).not.toMatch(/LEAK/);
    });

    test("drops an unnamed field nested inside one it names", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("probe", {
                version: "1.0.0",
                describe: "Answers a nested row.",
                routes: [{
                    method: "GET",
                    path: "/me",
                    describe: "Answers the caller.",
                    public: true,
                    input: z.object({}),
                    output: z.object({ item: z.object({ id: z.string() }) }),
                    handle: () => ({ item: SECRET }),
                }],
            } as Definition)],
        });

        await kernel.start();

        const answer = await kernel.handle({ method: "GET", path: "/me", input: {} });

        expect(answer.body).toEqual({ item: { id: "u1" } });
    });
});
