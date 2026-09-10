import { afterEach, describe, expect, test, vi } from "vitest";

import { httpClient, HttpRequestError } from "../api";

type FetchStub = {
    status?: number;
    body?: string;
    redirected?: boolean;
    headers?: Record<string, string>;
};

function stubFetch(answer: FetchStub = {}): void
{
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
    {
        if (init?.signal?.aborted === true)
        {
            return Promise.reject(new DOMException("aborted", "AbortError"));
        }

        const status = answer.status ?? 200;
        const text = answer.body ?? "{}";

        return Promise.resolve(new Response(text === "" ? null : text, { status, ...(answer.headers !== undefined && { headers: answer.headers }) }));
    });
}

afterEach(() =>
{
    vi.unstubAllGlobals();
});

describe("answers", () =>
{
    test("returns the parsed body", async () =>
    {
        stubFetch({ body: '{"ok":true}' });

        await expect(httpClient()({ method: "GET", url: "https://api.example.test/x" })).resolves.toEqual({ ok: true });
    });

    test("returns undefined for an empty body", async () =>
    {
        stubFetch({ status: 204, body: "" });

        await expect(httpClient()({ method: "GET", url: "https://api.example.test/x" })).resolves.toBeUndefined();
    });

    test("refuses a body that is not JSON", async () =>
    {
        stubFetch({ body: "not json" });

        await expect(httpClient()({ method: "GET", url: "https://api.example.test/x" })).rejects.toMatchObject({ code: "MALFORMED" });
    });

    test("answers a page as text when the call asked for text", async () =>
    {
        stubFetch({ body: "<html><h1>Hi</h1></html>" });

        await expect(httpClient()({ method: "GET", url: "https://api.example.test/x", accepts: "text" }))
            .resolves.toBe("<html><h1>Hi</h1></html>");
    });

    test("asking for text sends an accept that a page can answer", async () =>
    {
        let sent: Readonly<Record<string, string>> = {};

        vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
        {
            sent = init?.headers as Readonly<Record<string, string>>;

            return Promise.resolve(new Response("<html></html>", { status: 200 }));
        });

        await httpClient()({ method: "GET", url: "https://api.example.test/x", accepts: "text" });

        expect(sent["accept"]).toBe("*/*");
    });

    test("refuses a non-2xx status, carrying it", async () =>
    {
        stubFetch({ status: 402, body: '{"error":"card declined"}' });

        const failed = await httpClient()({ method: "GET", url: "https://api.example.test/x" }).catch((cause: unknown) => cause);

        expect(failed).toBeInstanceOf(HttpRequestError);
        expect((failed as HttpRequestError).status).toBe(402);
    });

    test("refuses an answer past the size it was given", async () =>
    {
        stubFetch({ body: "x".repeat(2_000) });

        await expect(httpClient({ maxBytes: 100 })({ method: "GET", url: "https://api.example.test/x" }))
            .rejects.toMatchObject({ code: "TOO_LARGE" });
    });
});

describe("cancelling", () =>
{
    test("tells a caller's abort apart from a timeout", async () =>
    {
        vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
            new Promise((_keep, fail) =>
            {
                init?.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
            }));

        const stopper = new AbortController();

        const aborted = httpClient()({ method: "GET", url: "https://api.example.test/x", signal: stopper.signal });

        stopper.abort();

        await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    });

    test("answers TIMEOUT when nothing came back in time", async () =>
    {
        vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
            new Promise((_keep, fail) =>
            {
                init?.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
            }));

        await expect(httpClient({ timeoutMs: 10 })({ method: "GET", url: "https://api.example.test/x" }))
            .rejects.toMatchObject({ code: "TIMEOUT" });
    });
});

describe("redirects", () =>
{
    test("never follows one, so a permitted host cannot hand the call on", async () =>
    {
        let asked: RequestInit | undefined;

        vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
        {
            asked = init;

            return Promise.resolve(new Response("{}", { status: 200 }));
        });

        await httpClient()({ method: "GET", url: "https://api.example.test/x" });

        expect(asked?.redirect).toBe("error");
    });
});

describe("what a partner asked for when it refused", () =>
{
    test("carries how long it wants to be left alone", async () =>
    {
        stubFetch({ status: 429, body: "{}", headers: { "retry-after": "120" } });

        const failed = await httpClient()({ method: "GET", url: "https://api.example.test/x" })
            .catch((cause: unknown) => cause) as HttpRequestError;

        expect(failed.retryAfter).toBe(120);
    });

    test("and reads a moment as the seconds until it", async () =>
    {
        const at = new Date(Date.now() + 60_000).toUTCString();

        stubFetch({ status: 503, body: "{}", headers: { "retry-after": at } });

        const failed = await httpClient()({ method: "GET", url: "https://api.example.test/x" })
            .catch((cause: unknown) => cause) as HttpRequestError;

        expect(failed.retryAfter).toBeGreaterThan(50);
        expect(failed.retryAfter).toBeLessThanOrEqual(60);
    });

    test("while one that said nothing carries nothing", async () =>
    {
        stubFetch({ status: 429, body: "{}" });

        const failed = await httpClient()({ method: "GET", url: "https://api.example.test/x" })
            .catch((cause: unknown) => cause) as HttpRequestError;

        expect(failed.retryAfter).toBeUndefined();
    });
});
