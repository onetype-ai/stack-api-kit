import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, Reply } from "../../kernel/api";
import { serve } from "../api";
import { cookieFor, cookieIn, sessionCookie } from "../internal/session";

import type { Definition } from "../../kernel/api";

const settings = { name: "app_session", secure: false } as const;

async function startServer(found: Partial<Definition>, session?: Parameters<typeof serve>[0]["session"])
{
    const kernel = createKernel({
        plugins: [definePlugin("auth", { version: "1.0.0", describe: "Signs people in.", ...found } as Definition)],
    });

    await kernel.start();

    return serve({ kernel, ...(session !== undefined && { session }) });
}

/** A route that hands back a session, as one signing somebody in would. */
const signIn = {
    routes: [{
        method: "POST" as const,
        path: "/sign-in",
        describe: "Starts a session.",
        public: true,
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handle: () => new Reply(200, { ok: true }, {
            "x-session-key": "abc123",
            "x-session-expires": String(Date.now() + 3600_000),
        }),
    }],
};

describe("a route that starts a session", () =>
{
    test("answers a cookie the browser will not hand to a script", async () =>
    {
        const app = await startServer(signIn, settings);

        const answer = await app.fetch(new Request("http://localhost/sign-in", { method: "POST" }));
        const cookie = answer.headers.get("set-cookie") ?? "";

        expect(cookie).toContain("app_session=abc123");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
    });

    test("and the key never also leaves on a header a script can read", async () =>
    {
        const app = await startServer(signIn, settings);

        const answer = await app.fetch(new Request("http://localhost/sign-in", { method: "POST" }));

        expect(answer.headers.get("x-session-key")).toBeNull();
        expect(answer.headers.get("x-session-expires")).toBeNull();
    });

    test("but leaves them alone when nothing asked for a cookie", async () =>
    {
        const app = await startServer(signIn);

        const answer = await app.fetch(new Request("http://localhost/sign-in", { method: "POST" }));

        expect(answer.headers.get("set-cookie")).toBeNull();
        expect(answer.headers.get("x-session-key")).toBe("abc123");
    });
});

describe("a route that ends one", () =>
{
    test("answers a cookie that expires at once", async () =>
    {
        const app = await startServer({
            routes: [{
                method: "POST", path: "/sign-out", describe: "Ends a session.", public: true,
                input: z.object({}), output: z.object({ ok: z.boolean() }),
                handle: () => new Reply(200, { ok: true }, { "x-session-end": "true" }),
            }],
        }, settings);

        const answer = await app.fetch(new Request("http://localhost/sign-out", { method: "POST" }));
        const cookie = answer.headers.get("set-cookie") ?? "";

        expect(cookie).toContain("app_session=;");
        expect(cookie).toContain("Max-Age=0");
    });
});

describe("when a session ends", () =>
{
    test("is a moment, and a lifetime sent instead is refused rather than kept", () =>
    {
        const now = Date.now();

        expect(() => sessionCookie({ "x-session-key": "abc", "x-session-expires": "2592000" }, settings, now))
            .toThrow(/moment in epoch milliseconds/);
    });
});

describe("what a cookie carries", () =>
{
    test("is marked Secure only where a browser would keep it", () =>
    {
        expect(cookieFor("k", 60, { name: "s", secure: true })).toContain("Secure");
        expect(cookieFor("k", 60, { name: "s", secure: false })).not.toContain("Secure");
    });

    test("and is marked Secure anyway for SameSite=None, which needs it", () =>
    {
        expect(cookieFor("k", 60, { name: "s", secure: false, sameSite: "None" })).toContain("Secure");
    });

    test("escapes a key holding what would otherwise end the cookie", () =>
    {
        const cookie = cookieFor("a;b c=d", 60, { name: "s", secure: false });

        expect(cookie).toContain("s=a%3Bb%20c%3Dd");
        expect(cookie.split(";").length).toBe(5);
    });

    test("never a negative age, whatever the clock says", () =>
    {
        expect(cookieFor("k", -900, { name: "s", secure: false })).toContain("Max-Age=0");
    });
});

describe("reading one back", () =>
{
    test("finds it among others", () =>
    {
        expect(cookieIn("other=1; app_session=abc; third=3", "app_session")).toBe("abc");
    });

    test("keeps every character after the first equals", () =>
    {
        expect(cookieIn("app_session=a=b=c", "app_session")).toBe("a=b=c");
    });

    test("is nothing when the header holds no such name", () =>
    {
        expect(cookieIn("other=1", "app_session")).toBeUndefined();
        expect(cookieIn(undefined, "app_session")).toBeUndefined();
    });

    test("never matches a name that merely ends the same way", () =>
    {
        expect(cookieIn("evil_app_session=stolen", "app_session")).toBeUndefined();
    });
});

describe("an expiry that makes no sense", () =>
{
    test("closes the session rather than opening an endless one", () =>
    {
        const answer = sessionCookie(
            { "x-session-key": "k", "x-session-expires": "not a number" },
            { name: "s", secure: false },
            Date.now(),
        );

        expect(answer.cookie).toContain("Max-Age=0");
    });

    test("and one already past does the same", () =>
    {
        const answer = sessionCookie(
            { "x-session-key": "k", "x-session-expires": String(Date.now() - 60_000) },
            { name: "s", secure: false },
            Date.now(),
        );

        expect(answer.cookie).toContain("Max-Age=0");
    });
});
