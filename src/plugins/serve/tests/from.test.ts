import { describe, expect, test } from "vitest";

import { from } from "../api";

function carrying(headers: Record<string, string> = {})
{
    return { req: { header: (name: string) => headers[name.toLowerCase()] } };
}

describe("what a rate limit counts an unknown identity by", () =>
{
    test("is never the header itself when no proxy is named", () =>
    {
        expect(from(false)(carrying({ "x-forwarded-for": "203.0.113.7" }))).toBe("anonymous");
    });

    test("refuses trusting the first hop, which a caller writes, naming the fix", () =>
    {
        expect(() => from(true as never)).toThrow(/Server.from\(true\) is gone in 9.0.*trustedProxies/u);
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
