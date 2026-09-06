import { afterEach, describe, expect, test, vi } from "vitest";

import { dial, OutboundFault } from "../api";

type FetchStub = {
    status?: number;
    body?: string;
    redirected?: boolean;
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

        return Promise.resolve(new Response(text === "" ? null : text, { status }));
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

        await expect(dial()({ method: "GET", url: "https://api.example.test/x" })).resolves.toEqual({ ok: true });
    });

    test("returns undefined for an empty body", async () =>
    {
        stubFetch({ status: 204, body: "" });

        await expect(dial()({ method: "GET", url: "https://api.example.test/x" })).resolves.toBeUndefined();
    });

    test("refuses a body that is not JSON", async () =>
    {
        stubFetch({ body: "not json" });

        await expect(dial()({ method: "GET", url: "https://api.example.test/x" })).rejects.toMatchObject({ code: "MALFORMED" });
    });

    test("refuses a non-2xx status, carrying it", async () =>
    {
        stubFetch({ status: 402, body: '{"error":"card declined"}' });

        const failed = await dial()({ method: "GET", url: "https://api.example.test/x" }).catch((cause: unknown) => cause);

        expect(failed).toBeInstanceOf(OutboundFault);
        expect((failed as OutboundFault).status).toBe(402);
    });

    test("refuses an answer past the size it was given", async () =>
    {
        stubFetch({ body: "x".repeat(2_000) });

        await expect(dial({ maxBytes: 100 })({ method: "GET", url: "https://api.example.test/x" }))
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

        const aborted = dial()({ method: "GET", url: "https://api.example.test/x", signal: stopper.signal });

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

        await expect(dial({ timeoutMs: 10 })({ method: "GET", url: "https://api.example.test/x" }))
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

        await dial()({ method: "GET", url: "https://api.example.test/x" });

        expect(asked?.redirect).toBe("error");
    });
});
