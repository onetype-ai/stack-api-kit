import { describe, expect, test } from "vitest";

import { Log } from "../api";

const read = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe("a line written through Log", () =>
{
    test.each(["password", "api_key", "X-Api-Key", "accessToken", "sessionId", "cookie", "authorization", "clientSecret", "signature"])("never carries the value of %s", (key) =>
    {
        const line = read(Log.line("info", "signed in", { [key]: "hunter2-value" }));

        expect(line[key]).toBe("[redacted]");
    });

    test("keeps a count of something sensitive, which is not the thing", () =>
    {
        const line = read(Log.line("info", "answered", { promptTokens: 120, tokenCount: 3, keyLength: 32 }));

        expect(line).toMatchObject({ promptTokens: 120, tokenCount: 3, keyLength: 32 });
    });

    test.each([
        ["a bearer token", "sent Bearer abc.def.ghi to the partner", "Bearer [redacted]"],
        ["a JWT", "cookie was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln here", "[jwt]"],
        ["a live key", "charged with sk_live_AbCdEf123456789", "[secret]"],
        ["a token in a query", "called https://x.test/cb?token=abc123&page=2", "token=[redacted]"],
    ])("masks %s inside a message or a value", (_what, text, masked) =>
    {
        const line = read(Log.line("warn", text, { detail: text }));

        expect(line["line"]).toContain(masked);
        expect(line["detail"]).toContain(masked);
    });

    test("reads a nested error apart, masking what it says", () =>
    {
        const line = read(Log.line("error", "failed", { cause: new Error("rejected Bearer secret-1") }));

        expect(line["cause"]).toMatchObject({ message: "rejected Bearer [redacted]" });
    });

    test("keeps a person's email and address unless asked to mask them", () =>
    {
        const kept = read(Log.line("info", "mailed ana@example.test", { email: "ana@example.test", ip: "203.0.113.7" }));
        const masked = read(Log.line("info", "mailed ana@example.test from 203.0.113.7", { email: "ana@example.test", ip: "203.0.113.7" }, { personal: true }));

        expect(kept).toMatchObject({ email: "ana@example.test", ip: "203.0.113.7" });
        expect(masked).toMatchObject({ email: "[redacted]", ip: "[redacted]", line: "mailed [email] from [ip]" });
    });
});
