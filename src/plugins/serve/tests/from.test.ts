import { describe, expect, test } from "vitest";

import { from } from "../api";

function carrying(headers: Record<string, string> = {})
{
    return { req: { header: (name: string) => headers[name.toLowerCase()] } };
}

describe("what a rate limit counts an unknown identity by", () =>
{
    test("is the forwarded address when a proxy is known to set it", () =>
    {
        expect(from(true)(carrying({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    });

    test("and the first of the chain, which is the client the proxy saw", () =>
    {
        expect(from(true)(carrying({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" })))
            .toBe("203.0.113.7");
    });

    test("but never the header itself when nothing in front sets it", () =>
    {
        expect(from(false)(carrying({ "x-forwarded-for": "203.0.113.7" }))).toBe("anonymous");
    });

    test("and an empty or absent one counts as the shared stranger", () =>
    {
        expect(from(true)(carrying({ "x-forwarded-for": "" }))).toBe("anonymous");
        expect(from(true)(carrying({ "x-forwarded-for": "   " }))).toBe("anonymous");
        expect(from(true)(carrying())).toBe("anonymous");
    });
});
