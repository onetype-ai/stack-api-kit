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

describe("the address of a caller behind proxies the deployment names", () =>
{
    const through = (peer: string, forwarded?: string) => ({
        req: { header: (name: string) => (name === "x-forwarded-for" ? forwarded : undefined) },
        env: { incoming: { socket: { remoteAddress: peer } } },
    });

    const behind = from({ trustedProxies: ["10.0.0.0/8", "192.0.2.10"] });

    test("is the rightmost hop no trusted proxy wrote, however many a caller prepends", () =>
    {
        expect(behind(through("10.0.0.2", "6.6.6.6, 203.0.113.7, 192.0.2.10"))).toBe("203.0.113.7");
    });

    test("is the socket itself when that is not a trusted proxy, whatever the header says", () =>
    {
        expect(behind(through("198.51.100.4", "203.0.113.7"))).toBe("198.51.100.4");
    });

    test("reads a dual-stack socket's IPv4 as itself", () =>
    {
        expect(from(false)(through("::ffff:198.51.100.4"))).toBe("198.51.100.4");
    });

    test("is nobody known when a hop is not an address", () =>
    {
        expect(behind(through("10.0.0.2", "not-an-address"))).toBe("anonymous");
    });

    test("refuses a proxy named as neither an address nor a range", () =>
    {
        expect(() => from({ trustedProxies: ["proxy.internal"] })).toThrow("\"proxy.internal\" is not an address or a range");
        expect(() => from({ trustedProxies: ["10.0.0.0/99"] })).toThrow("\"10.0.0.0/99\" is not an address or a range");
    });
});
