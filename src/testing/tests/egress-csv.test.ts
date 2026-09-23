import { describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, Egress, Reply } from "../../index";
import { startTestKernel } from "../startTestKernel";

describe("an address checked as it is saved", () =>
{
    const answering = (address: string) => () => Promise.resolve([{ address, family: 4 }]);

    test.each([
        ["a public name", "https://docs.example.test/page", answering("93.184.215.14"), { allowed: true }],
        ["a name resolving inside", "https://innocent.example.test/", answering("10.0.0.5"), { allowed: false, reason: "blocked_address" }],
        ["a loopback literal", "https://127.0.0.1/", answering("93.184.215.14"), { allowed: false, reason: "blocked_address" }],
        ["plain http", "http://docs.example.test/", answering("93.184.215.14"), { allowed: false, reason: "refused_url" }],
        ["a name that does not resolve", "https://nowhere.example.test/", () => Promise.resolve([]), { allowed: false, reason: "unresolvable" }],
    ])("answers as the dial would for %s", async (_what, url, lookup, verdict) =>
    {
        expect(await Egress.check(url, lookup)).toEqual(verdict);
    });
});

describe("a CSV answered by a route", () =>
{
    const exporting = definePlugin("items", {
        version: "1.0.0",
        describe: "Exports items.",
        routes: [{
            method: "GET",
            path: "/items/export",
            describe: "Every item, as CSV.",
            public: true,
            input: z.object({}),
            file: { types: ["text/csv"] },
            handle: () => Reply.csv([
                { title: "Plain", note: "one, two" },
                { title: "=HYPERLINK(\"https://evil.test\")", note: "-1+1" },
                { title: "Quote \"inside\"", note: null },
            ], { columns: ["title", "note"], filename: "items.csv" }),
        }],
    } as unknown as Parameters<typeof definePlugin>[1]);

    test("keeps every cell a spreadsheet would run as text, and quotes what needs it", async () =>
    {
        const api = await startTestKernel({ plugins: [exporting] });
        const answer = await api.kernel.handle({ method: "GET", path: "/items/export", input: {} });

        await api.stop();

        expect(answer.body).toBe("title,note\r\nPlain,\"one, two\"\r\n\"'=HYPERLINK(\"\"https://evil.test\"\")\",\"'-1+1\"\r\n\"Quote \"\"inside\"\"\",\r\n");
        expect(answer.headers?.["content-type"]).toBe("text/csv; charset=utf-8");
    });
});
