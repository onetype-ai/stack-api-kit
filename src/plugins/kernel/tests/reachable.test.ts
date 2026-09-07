import { describe, expect, test } from "vitest";

import { whyUnfetchable } from "../internal/reachable";

describe("an address anywhere may not reach", () =>
{
    test("loopback, however it is written", () =>
    {
        for (const host of [
            "https://127.0.0.1/",
            "https://localhost/",
            "https://LOCALHOST./",
            "https://0x7f000001/",
            "https://2130706433/",
            "https://127.1/",
            "https://0177.0.0.1/",
            "https://[::1]/",
        ])
        {
            expect(whyUnfetchable(host), host).toBeDefined();
        }
    });

    test("a loopback address mapped into IPv6", () =>
    {
        expect(whyUnfetchable("https://[::ffff:127.0.0.1]/")).toBeDefined();
        expect(whyUnfetchable("https://[::ffff:10.0.0.1]/")).toBeDefined();
    });

    test("the cloud metadata endpoint and everything link-local", () =>
    {
        expect(whyUnfetchable("https://169.254.169.254/latest/meta-data/")).toBeDefined();
        expect(whyUnfetchable("https://[fe80::1]/")).toBeDefined();
    });

    test("every private range", () =>
    {
        for (const host of [
            "https://10.0.0.5/",
            "https://172.16.0.1/",
            "https://172.31.255.254/",
            "https://192.168.1.1/",
            "https://100.64.0.1/",
            "https://[fd00::1]/",
        ])
        {
            expect(whyUnfetchable(host), host).toBeDefined();
        }
    });

    test("a scheme ctx.fetch does not speak", () =>
    {
        for (const host of ["http://example.com/", "file:///etc/passwd", "ftp://example.com/"])
        {
            expect(whyUnfetchable(host), host).toBeDefined();
        }
    });

    test("a port the web is not served on", () =>
    {
        for (const host of ["https://example.com:22/", "https://example.com:6379/", "https://example.com:5432/"])
        {
            expect(whyUnfetchable(host), host).toBeDefined();
        }
    });

    test("a credential smuggled into the address", () =>
    {
        expect(whyUnfetchable("https://user:secret@example.com/")).toBeDefined();
    });

    test("something that is not an address at all", () =>
    {
        expect(whyUnfetchable("not a url")).toBeDefined();
        expect(whyUnfetchable("")).toBeDefined();
    });
});

describe("an address anywhere may reach", () =>
{
    test("an ordinary site, on its own port and by address", () =>
    {
        for (const host of [
            "https://example.com/",
            "https://sub.example.com/page?q=1",
            "https://example.com:443/x",
            "https://93.184.216.34/",
        ])
        {
            expect(whyUnfetchable(host), host).toBeUndefined();
        }
    });

    test("a public address that merely looks close to a private one", () =>
    {
        for (const host of [
            "https://11.0.0.1/",
            "https://172.15.0.1/",
            "https://172.32.0.1/",
            "https://192.169.0.1/",
            "https://100.63.0.1/",
        ])
        {
            expect(whyUnfetchable(host), host).toBeUndefined();
        }
    });
});
