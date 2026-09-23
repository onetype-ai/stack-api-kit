import { afterEach, describe, expect, test } from "vitest";

import { definePlugin, HttpRequestError } from "../../index";
import { startTestKernel } from "../startTestKernel";

import type { HttpRequest, StreamedResponse } from "../../index";
import type { TestKernel } from "../startTestKernel";

type Answer = { address: string; family: number };

const crawler = definePlugin("crawler", {
    version: "1.0.0",
    describe: "Reaches addresses a row names.",
    allowedHosts: "anywhere",
});

const provider = definePlugin("provider", {
    version: "1.0.0",
    describe: "Reaches one host it names.",
    allowedHosts: ["https://api.provider.test"],
});

const PUBLIC: Answer = { address: "93.184.216.34", family: 4 };

let api: TestKernel | undefined;

afterEach(async () =>
{
    await api?.stop();
    api = undefined;
});

// Every name answers a public address but those a test names, as DNS would.
const lookupWith = (named: Readonly<Record<string, Answer>>) => (hostname: string): Promise<readonly Answer[]> =>
{
    return Promise.resolve([named[hostname] ?? PUBLIC]);
};

const hopTo = (status: number, location: string): StreamedResponse =>
{
    return { status, headers: { location }, url: "", location, body: (async function* () {})() };
};

const landed = (): StreamedResponse =>
{
    return { status: 200, headers: { "content-type": "text/html" }, url: "", body: (async function* () {})() };
};

const boot = async (respond: (call: HttpRequest) => unknown, named: Readonly<Record<string, Answer>> = {}): Promise<TestKernel> =>
{
    api = await startTestKernel({ plugins: [crawler, provider], respondWith: respond, lookup: lookupWith(named) });

    return api;
};

// A chain of pages: each url redirects where the map says, anything else lands.
const chain = (hops: Readonly<Record<string, readonly [number, string]>>) => (call: HttpRequest): unknown =>
{
    const hop = hops[call.url];

    return hop === undefined ? landed() : hopTo(hop[0], hop[1]);
};

const follow = (kernel: TestKernel, call: Partial<HttpRequest> & { url: string }): Promise<StreamedResponse> =>
{
    return kernel.kernel.context("crawler").fetch({ method: "GET", redirects: "follow", ...call, accepts: "stream" });
};

describe("a crawler following redirects", () =>
{
    test("lands where the chain ends, pinning every hop to the address it checked", async () =>
    {
        const kernel = await boot(chain({
            "https://short.example/a": [301, "https://www.example.com/a"],
            "https://www.example.com/a": [302, "https://www.example.com/final"],
        }), { "www.example.com": { address: "93.184.216.40", family: 4 } });

        const answer = await follow(kernel, { url: "https://short.example/a" });

        expect(answer.status).toBe(200);
        expect(answer.url).toBe("https://www.example.com/final");
        expect(kernel.sentRequests().map((sent) => [sent.url, sent.address])).toEqual([
            ["https://short.example/a", "93.184.216.34"],
            ["https://www.example.com/a", "93.184.216.40"],
            ["https://www.example.com/final", "93.184.216.40"],
        ]);
    });

    test.each([
        ["a name resolving to cloud metadata", "https://metadata.example/latest", { "metadata.example": { address: "169.254.169.254", family: 4 } }, "blocked_address"],
        ["a loopback literal", "https://127.0.0.1/admin", {}, "blocked_address"],
        ["a private network name", "https://intranet.example/", { "intranet.example": { address: "10.0.0.8", family: 4 } }, "blocked_address"],
        ["localhost by name", "https://localhost/", {}, "blocked_address"],
        ["plain http, a downgrade", "http://www.example.com/", {}, "refused_url"],
    ])("refuses a hop to %s with the reason a direct call gets, and never dials it", async (_what, target, named, reason) =>
    {
        const kernel = await boot(chain({ "https://innocent.example/": [302, target] }), named);

        const refusal = await follow(kernel, { url: "https://innocent.example/" }).catch((cause: unknown) => cause);

        expect(refusal).toMatchObject({ code: "UNDECLARED_HOST", detail: { reason } });
        expect(kernel.sentRequests().map((sent) => sent.url)).toEqual(["https://innocent.example/"]);
    });

    test("stops after five hops by default, and after the number a call names", async () =>
    {
        const kernel = await boot((call) => hopTo(302, `${call.url}x`));

        const byDefault = await follow(kernel, { url: "https://loop.example/" }).catch((cause: unknown) => cause);
        const dialledByDefault = kernel.sentRequests().length;
        const named = await follow(kernel, { url: "https://loop.example/", mostRedirects: 2 }).catch((cause: unknown) => cause);

        expect(byDefault).toMatchObject({ code: "TOO_MANY_REDIRECTS" });
        expect(dialledByDefault).toBe(6);
        expect(named).toMatchObject({ code: "TOO_MANY_REDIRECTS" });
        expect(kernel.sentRequests()).toHaveLength(6 + 3);
    });

    test("turns a POST answered 303 into a GET without a body, and keeps both through a 307", async () =>
    {
        const kernel = await boot(chain({
            "https://forms.example/send": [307, "https://forms.example/send-again"],
            "https://forms.example/send-again": [303, "https://forms.example/thanks"],
        }));

        await follow(kernel, { method: "POST", url: "https://forms.example/send", body: { name: "Ada" } });

        expect(kernel.sentRequests().map((sent) => [sent.method, sent.body])).toEqual([
            ["POST", { name: "Ada" }],
            ["POST", { name: "Ada" }],
            ["GET", undefined],
        ]);
    });

    test("keeps a PUT and its body through a 301, as the fetch standard does, turning only a POST into a GET", async () =>
    {
        const kernel = await boot(chain({
            "https://docs.example/put": [301, "https://docs.example/put-here"],
            "https://docs.example/post": [302, "https://docs.example/posted"],
        }));

        await follow(kernel, { method: "PUT", url: "https://docs.example/put", body: { title: "A" } });
        await follow(kernel, { method: "POST", url: "https://docs.example/post", body: { title: "B" } });

        expect(kernel.sentRequests().map((sent) => [sent.method, sent.body])).toEqual([
            ["PUT", { title: "A" }],
            ["PUT", { title: "A" }],
            ["POST", { title: "B" }],
            ["GET", undefined],
        ]);
    });

    test("bounds the whole chain by the call's timeout, not each hop by it", async () =>
    {
        const given: number[] = [];
        const kernel = await boot(async (call) =>
        {
            given.push(call.timeoutMs ?? Number.POSITIVE_INFINITY);
            await new Promise((resolve) => setTimeout(resolve, 40));
            const hop = /\/(\d)$/.exec(call.url);
            const at = Number(hop?.[1] ?? 0);

            return at < 4 ? hopTo(302, `https://slow.example/${String(at + 1)}`) : landed();
        });

        const refusal = await follow(kernel, { url: "https://slow.example/0", timeoutMs: 100 }).catch((cause: unknown) => cause);

        expect(refusal).toMatchObject({ code: "TIMEOUT" });
        expect(kernel.sentRequests().length).toBeLessThan(5);
        expect(given[0]).toBeLessThanOrEqual(100);
        expect(given[1]).toBeLessThan(given[0] ?? 0);
    });

    test("keeps the call's headers on its own origin and drops them on another", async () =>
    {
        const kernel = await boot(chain({
            "https://docs.example/a": [302, "https://docs.example/b"],
            "https://docs.example/b": [302, "https://cdn.example/b"],
        }));

        await follow(kernel, { url: "https://docs.example/a", headers: { "if-none-match": "\"v1\"" } });

        expect(kernel.sentRequests().map((sent) => sent.headers?.["if-none-match"])).toEqual(["\"v1\"", "\"v1\"", undefined]);
    });

    test("follows a redirect when the answer is read whole, too", async () =>
    {
        const kernel = await boot((call) =>
        {
            if (call.url === "https://api.example/old")
            {
                throw new HttpRequestError("REDIRECT", "moved", 308, undefined, undefined, "https://api.example/new");
            }

            return { moved: true };
        });

        const answer = await kernel.kernel.context("crawler").fetch({ method: "GET", url: "https://api.example/old", redirects: "follow" });

        expect(answer).toEqual({ moved: true });
    });

    test("hands a 304 back as it came rather than treating it as a hop", async () =>
    {
        const kernel = await boot(() => ({ status: 304, headers: { etag: "\"v1\"" }, url: "", body: (async function* () {})() }));

        const answer = await follow(kernel, { url: "https://docs.example/a" });

        expect(answer.status).toBe(304);
        expect(kernel.sentRequests()).toHaveLength(1);
    });
});

describe("a crawler taking redirects by hand", () =>
{
    test("gets the 3xx back with where it points, dialling nothing further", async () =>
    {
        const kernel = await boot(chain({ "https://short.example/a": [302, "https://www.example.com/a"] }));

        const answer = await follow(kernel, { url: "https://short.example/a", redirects: "manual" });

        expect(answer).toMatchObject({ status: 302, location: "https://www.example.com/a", url: "https://short.example/a" });
        expect(kernel.sentRequests()).toHaveLength(1);
    });
});

describe("redirects asked for where they cannot be checked", () =>
{
    test("are refused for a plugin that declares its hosts, naming anywhere", async () =>
    {
        const kernel = await boot(() => landed());

        await expect(kernel.kernel.context("provider").fetch({ method: "GET", url: "https://api.provider.test/v1", redirects: "follow" })).rejects.toThrow("allowedHosts \"anywhere\"");
    });

    test.each([0, 11, 2.5])("refuse mostRedirects %s, naming the range", async (most) =>
    {
        const kernel = await boot(() => landed());

        await expect(follow(kernel, { url: "https://docs.example/", mostRedirects: most })).rejects.toThrow("from 1 to 10");
    });

    test("refuse a redirects mode it does not know", async () =>
    {
        const kernel = await boot(() => landed());

        await expect(follow(kernel, { url: "https://docs.example/", redirects: "always" as "follow" })).rejects.toThrow("refuse, manual, follow");
    });

    test("stamp the address that answered on a streamed answer from a declared host", async () =>
    {
        const kernel = await boot(() => landed());

        const answer = await kernel.kernel.context("provider").fetch({ method: "GET", url: "https://api.provider.test/v1", accepts: "stream" });

        expect(answer.url).toBe("https://api.provider.test/v1");
    });
});

describe("a call's maxBytes while following", () =>
{
    test("reaches it on every hop a followed redirect takes", async () =>
    {
        const seen: HttpRequest[] = [];
        api = await startTestKernel({
            plugins: [crawler],
            lookup: () => Promise.resolve([PUBLIC]),
            respondWith: (call) =>
            {
                seen.push(call);
                const location = call.url === "https://start.example/" ? "https://end.example/" : undefined;

                return { status: location === undefined ? 200 : 302, headers: location === undefined ? {} : { location }, url: "", ...(location !== undefined && { location }), body: (async function* () {})() } satisfies StreamedResponse;
            },
        });

        await api.kernel.context("crawler").fetch({ method: "GET", url: "https://start.example/", accepts: "stream", redirects: "follow", maxBytes: 100_000_000 });

        expect(seen.map((call) => [call.url, call.maxBytes])).toEqual([["https://start.example/", 100_000_000], ["https://end.example/", 100_000_000]]);
    });
});
