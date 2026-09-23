import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, defineRoute } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { TestKernel } from "../startTestKernel";


type Node = { type: string; properties?: Record<string, Node> | undefined };

const Name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const node: z.ZodType<Node> = z.lazy(() => z.object({ type: z.string(), properties: z.record(Name, node).optional() }));

const route = defineRoute();

const outputting = (output: z.ZodType, answer: unknown) => definePlugin("records", {
    version: "1.0.0",
    describe: "Answers a record.",
    routes: [route({
        method: "GET",
        path: "/records",
        describe: "Answers what the test gives it.",
        public: true,
        limit: { requests: 100, seconds: 60 },
        input: z.object({}),
        output,
        handle: () =>
        {
            return answer;
        },
    })],
});

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

describe("a record in an output schema", () =>
{
    test.each([
        ["a bare string key", z.record(z.string(), z.object({ a: z.string() }))],
        ["a value that forwards unnamed fields", z.record(Name, z.looseObject({ a: z.string() }))],
        ["an unknown value", z.record(Name, z.unknown())],
    ])("is refused at startup with %s", async (_what, output) =>
    {
        await expect(startTestKernel({ plugins: [outputting(output, {})] })).rejects.toThrow("cannot filter what leaves");
    });

    // c7's review of 3d: a pattern is judged by what it matches, never by how its text looks.
    test.each([
        ["an alternation escaping its anchors", /^safe|secretHash$/],
        ["a pattern matching anything", /^.*$/],
        ["a multiline flag loosening the anchors", /^[a-z]+$/m],
        ["a pattern letting a credential name through", /^[a-zA-Z]+$/],
        ["a pattern letting the empty key through", /^[a-z]*$/],
    ])("is refused at startup with %s over a scalar value", async (_what, pattern) =>
    {
        await expect(startTestKernel({ plugins: [outputting(z.record(z.string().regex(pattern), z.string()), {})] })).rejects.toThrow("cannot filter what leaves");
    });

    test("anchors a pattern at both ends itself, however it was written", async () =>
    {
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(/[a-z]+/), z.object({ a: z.string() })), { ok: { a: "1" }, "ok secretHash": { a: "2" }, "OK": { a: "3" } })] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ ok: { a: "1" } });
    });

    test("drops the flags that loosen anchoring, so a key cannot hide a second line", async () =>
    {
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(/^[a-z]{2}$/m), z.object({ a: z.string() })), { en: { a: "1" }, "en\nsecretHash": { a: "2" } })] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ en: { a: "1" } });
    });

    test("drops a key longer than 64 characters even when its pattern allows it", async () =>
    {
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(/^[a-z]+$/), z.object({ a: z.string() })), { short: { a: "1" }, ["b".repeat(65)]: { a: "2" } })] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ short: { a: "1" } });
    });

    // 04's condition on 3d: over any value, a pattern may not let a secret-shaped key out.
    test.each([
        ["an email", /^[a-z]@[a-z]\.[a-z]{2}$/],
        ["a JWT", /^eyJ[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9]+$/],
        ["a hyphenated key", /^sk-[a-z]+-[A-Za-z0-9]+$/],
        ["a key with a slash", /^[a-z]+\/[a-z]+\.[A-Za-z0-9]+$/],
    ])("is refused at startup when its pattern lets %s through, even over an object value", async (_what, pattern) =>
    {
        await expect(startTestKernel({ plugins: [outputting(z.record(z.string().regex(pattern), z.object({ a: z.string() })), {})] })).rejects.toThrow("cannot filter what leaves");
    });

    test("refuses over a scalar value a pattern letting an underscore sk_live key through", async () =>
    {
        await expect(startTestKernel({ plugins: [outputting(z.record(z.string().regex(/^sk_[a-z]+_[A-Za-z0-9]+$/), z.string()), {})] })).rejects.toThrow("cannot filter what leaves");
    });

    test.each([
        ["a property-name pattern (91's tools)", /^[A-Za-z_][A-Za-z0-9_]{0,63}$/],
        ["a BCP 47 locale pattern (d7's widget)", /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/],
    ])("boots with %s over an object value", async (_what, pattern) =>
    {
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(pattern), z.object({ a: z.string() })), {})] });

        expect(api.kernel.started()).toBe(true);
    });

        test("reads an escaped dollar as the character it is, so only that exact key leaves", async () =>
    {
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(/^id\$/), z.string()), { "id$": "ok", "id$secretHash": "x", id: "no" })] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ "id$": "ok" });
    });

    test("drops the prototype keys and the empty key as it sends, whatever the pattern lets through", async () =>
    {
        const answer = JSON.parse("{\"__proto__\":{\"a\":\"x\"},\"constructor\":{\"a\":\"x\"},\"prototype\":{\"a\":\"x\"},\"name\":{\"a\":\"ok\"}}") as unknown;
        api = await startTestKernel({ plugins: [outputting(z.record(z.string().regex(/^[a-z_]*$/), z.object({ a: z.string() })), answer)] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(JSON.stringify(response.body)).toBe("{\"name\":{\"a\":\"ok\"}}");
    });

    test("never lets out a key the compiled, anchored pattern refuses, nor one past 64 characters", async () =>
    {
        const locales = z.record(z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/), z.string());
        const answer = { en: "Hi", "de-DE": "Hallo", "en\nsecretHash": "x", ["aaa"]: "ok", ["b".repeat(65)]: "too long" };
        api = await startTestKernel({ plugins: [outputting(locales, answer)] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ en: "Hi", "de-DE": "Hallo", aaa: "ok" });
    });

    test.each([
        ["an anchored pattern key", z.record(Name, z.object({ a: z.string() }))],
        ["an enum key", z.partialRecord(z.enum(["en", "de"]), z.object({ a: z.string() }))],
        ["a literal union key", z.partialRecord(z.union([z.literal("en"), z.literal("de")]), z.object({ a: z.string() }))],
        ["a recursive JSON Schema node, whose property may be called password", node],
    ])("boots with %s", async (_what, output) =>
    {
        api = await startTestKernel({ plugins: [outputting(output, {})] });

        expect(api.kernel.started()).toBe(true);
    });

    test("drops a key outside the pattern and a field the value does not name, at every depth", async () =>
    {
        const answer = {
            type: "object",
            internal: "never leaves",
            properties: {
                city: { type: "string", secret: "x" },
                "bad key!": { type: "string" },
                address: { type: "object", properties: { zip: { type: "string", hidden: 1 }, "../etc": { type: "string" } } },
            },
        };
        api = await startTestKernel({ plugins: [outputting(node, answer)] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            type: "object",
            properties: {
                city: { type: "string" },
                address: { type: "object", properties: { zip: { type: "string" } } },
            },
        });
    });

    test("keeps an enum-keyed record to its members", async () =>
    {
        api = await startTestKernel({ plugins: [outputting(z.object({ locales: z.partialRecord(z.enum(["en", "de"]), z.object({ title: z.string() })) }), { locales: { en: { title: "Hi", extra: 1 }, xx: { title: "?" } } })] });

        const response = await api.kernel.handle({ method: "GET", path: "/records", input: {} });

        expect(response.body).toEqual({ locales: { en: { title: "Hi" } } });
    });
});
