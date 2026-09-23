import { afterEach, describe, expect, test } from "vitest";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { TestKernel } from "../startTestKernel";

type Answer = { address: string; family: number };

const anywhere = definePlugin("crawler", {
    version: "1.0.0",
    describe: "Reaches addresses a row names.",
    allowedHosts: "anywhere",
});

const declared = definePlugin("provider", {
    version: "1.0.0",
    describe: "Reaches one host it names.",
    allowedHosts: ["https://api.provider.test"],
});

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

const resolving = (...rounds: readonly (readonly Answer[])[]): { lookup: (hostname: string) => Promise<readonly Answer[]>; asked: string[] } =>
{
    const asked: string[] = [];
    let round = 0;

    return {
        asked,
        lookup: (hostname) =>
        {
            asked.push(hostname);
            const answers = rounds[Math.min(round, rounds.length - 1)] ?? [];
            round += 1;

            return Promise.resolve(answers);
        },
    };
};

const fetchAs = (plugin: string, url: string): Promise<unknown> =>
{
    return (api as TestKernel).kernel.context(plugin).fetch({ method: "GET", url });
};

describe("a plugin reaching anywhere", () =>
{
    test.each([
        ["loopback", "127.0.0.1", 4],
        ["cloud metadata", "169.254.169.254", 4],
        ["a private network", "10.1.2.3", 4],
        ["IPv6 loopback", "::1", 6],
        ["an IPv4-mapped private address", "::ffff:192.168.1.3", 6],
    ])("is refused a public name that resolves to %s", async (_what, address, family) =>
    {
        const { lookup } = resolving([{ address, family }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        const call = fetchAs("crawler", "https://innocent.example/page");

        await expect(call).rejects.toThrow("resolves to an address not on the public internet");
        expect(api.sentRequests()).toEqual([]);
    });

    test("is refused when any one answer is private, not only the first", async () =>
    {
        const { lookup } = resolving([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await expect(fetchAs("crawler", "https://mixed.example/")).rejects.toThrow("not on the public internet");
    });

    test("is dialled at the address that was checked", async () =>
    {
        const { lookup } = resolving([{ address: "93.184.216.34", family: 4 }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await fetchAs("crawler", "https://public.example/page");

        expect(api.sentRequests()).toEqual([expect.objectContaining({ url: "https://public.example/page", address: "93.184.216.34" })]);
    });

    test("checks every call again, so a name that turns private later is refused then", async () =>
    {
        const { lookup } = resolving([{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await fetchAs("crawler", "https://rebinding.example/");
        const second = fetchAs("crawler", "https://rebinding.example/");

        await expect(second).rejects.toThrow("not on the public internet");
        expect(api.sentRequests()).toHaveLength(1);
    });

    test("is refused a name that does not resolve", async () =>
    {
        const { lookup } = resolving([]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await expect(fetchAs("crawler", "https://nowhere.example/")).rejects.toThrow("did not resolve");
    });
});

// One address from every IANA special-purpose block, v4 and v6: an allow-list
// means each is refused however the name that led to it was spelled.
const SPECIAL: readonly (readonly [string, string, number])[] = [
    ["this network 0/8", "0.1.2.3", 4],
    ["shared address space 100.64/10", "100.64.1.1", 4],
    ["IETF assignments 192.0.0/24", "192.0.0.9", 4],
    ["documentation 192.0.2/24", "192.0.2.1", 4],
    ["AS112 192.31.196/24", "192.31.196.1", 4],
    ["AMT 192.52.193/24", "192.52.193.1", 4],
    ["6to4 relay 192.88.99/24", "192.88.99.1", 4],
    ["direct delegation AS112 192.175.48/24", "192.175.48.1", 4],
    ["benchmarking 198.18/15", "198.19.255.1", 4],
    ["documentation 198.51.100/24", "198.51.100.1", 4],
    ["documentation 203.0.113/24", "203.0.113.1", 4],
    ["multicast 224/4", "239.1.1.1", 4],
    ["reserved 240/4", "250.1.1.1", 4],
    ["broadcast", "255.255.255.255", 4],
    ["unspecified ::", "::", 6],
    ["IPv4-compatible ::10.0.0.1", "::10.0.0.1", 6],
    ["IPv4-compatible metadata ::a9fe:a9fe", "::a9fe:a9fe", 6],
    ["NAT64 carrying a private v4", "64:ff9b::10.0.0.1", 6],
    ["discard-only 100::/64", "100::1", 6],
    ["Teredo 2001::/32", "2001:0:4136:e378::1", 6],
    ["IETF assignments 2001::/23", "2001:1ff::1", 6],
    ["documentation 2001:db8::/32", "2001:db8::1", 6],
    ["6to4 2002::/16 wrapping 10.0.0.1", "2002:a00:1::1", 6],
    ["documentation 3fff::/20", "3fff::1", 6],
    ["unique local fc00::/7", "fd12:3456::1", 6],
    ["link local fe80::/10", "fe80::1", 6],
    ["site local fec0::/10", "fec0::1", 6],
    ["multicast ff00::/8", "ff02::1", 6],
];

describe("every special-purpose block", () =>
{
    test.each(SPECIAL)("is refused behind a public name: %s", async (_block, address, family) =>
    {
        const { lookup } = resolving([{ address, family }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await expect(fetchAs("crawler", "https://innocent.example/")).rejects.toThrow("not on the public internet");
    });

    test.each(SPECIAL)("is refused written as a literal: %s", async (_block, address) =>
    {
        api = await startTestKernel({ plugins: [anywhere] });

        const literal = address.includes(":") ? `[${address}]` : address;

        await expect(fetchAs("crawler", `https://${literal}/`)).rejects.toThrow("not on the public internet");
    });

    test.each([
        ["IPv4", "93.184.215.14", 4],
        ["IPv6 global unicast", "2606:2800:21f:cb07:6820:80da:af6b:8b2c", 6],
        ["IPv4-mapped public", "::ffff:93.184.215.14", 6],
    ])("lets a globally routable address through: %s", async (_what, address, family) =>
    {
        const { lookup } = resolving([{ address, family }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await fetchAs("crawler", "https://public.example/");

        expect(api.sentRequests()).toHaveLength(1);
    });

    test.each(["app.localhost", "printer.local", "db.internal", "nas.home.arpa"])("refuses a name that never leaves the site by the name alone: %s", async (name) =>
    {
        const { lookup, asked } = resolving([{ address: "93.184.215.14", family: 4 }]);
        api = await startTestKernel({ plugins: [anywhere], lookup });

        await expect(fetchAs("crawler", `https://${name}/`)).rejects.toThrow("not on the public internet");
        expect(asked).toEqual([]);
    });
});

describe("a plugin reaching a host it declared", () =>
{
    test("is not resolved or pinned: its path is unchanged", async () =>
    {
        const { lookup, asked } = resolving([{ address: "127.0.0.1", family: 4 }]);
        api = await startTestKernel({ plugins: [declared], lookup });

        await fetchAs("provider", "https://api.provider.test/v1");

        expect(asked).toEqual([]);
        expect(api.sentRequests()[0]?.address).toBeUndefined();
    });
});

describe("a refusal's reason", () =>
{
    const reasonOf = async (url: string): Promise<unknown> =>
    {
        try
        {
            await fetchAs("crawler", url);
        }
        catch (cause)
        {
            return (cause as { detail?: { reason?: unknown } }).detail?.reason;
        }

        return "answered";
    };

    test.each([
        ["a name with no address", resolving([]), "https://nowhere.example/", "unresolvable"],
        ["a name DNS fails on", { lookup: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) }, "https://broken.example/", "unresolvable"],
        ["a name answering a private address", resolving([{ address: "10.0.0.1", family: 4 }]), "https://inside.example/", "blocked_address"],
        ["a private literal", resolving([]), "https://127.0.0.1/", "blocked_address"],
        ["a local name", resolving([]), "https://printer.local/", "blocked_address"],
        ["a plain http address", resolving([]), "http://public.example/", "refused_url"],
        ["something that is not an address", resolving([]), "not a url", "refused_url"],
    ])("names %s", async (_what, { lookup }, url, reason) =>
    {
        api = await startTestKernel({ plugins: [anywhere], lookup });

        expect(await reasonOf(url)).toBe(reason);
    });
});
