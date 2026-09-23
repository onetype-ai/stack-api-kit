import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin, Reply } from "../../kernel/api";
import { serve } from "../api";
import { cookieFor, cookieIn, sessionCookie, SessionHeaders, withSessionKey } from "../internal/session";

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

describe("a plugin that only ever learned about headers", () =>
{
    test("is handed the key the cookie holds, so `session` changes nothing for it", async () =>
    {
        let seen: string | null = null;

        const app = await startServer({
            identifies: (_ctx, request: Request) =>
            {
                seen = request.headers.get(SessionHeaders.key);

                return seen === null ? undefined : { id: "u1", claims: {} };
            },
            routes: [{
                method: "GET", path: "/me", describe: "Who is asking.", public: true,
                input: z.object({}), output: z.object({ ok: z.boolean() }),
                handle: () => ({ ok: true }),
            }],
        } as Partial<Definition>, settings);

        await app.fetch(new Request("http://localhost/me", { headers: { cookie: "app_session=abc123" } }));

        expect(seen).toBe("abc123");
    });
});

describe("when a session ends", () =>
{
    test("is a moment, and a lifetime sent instead is refused rather than kept", () =>
    {
        const moment = Date.now();

        expect(() => sessionCookie({ "x-session-key": "abc", "x-session-expires": "2592000" }, settings, moment))
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

describe("a plugin that reads the request while identifying", () =>
{
    test("leaves the body a closed route still has to parse", async () =>
    {
        const app = await startServer({
            permissions: { "auth.write": { describe: "Write while signed in." } },

            identifies: async (_ctx, request: Request) =>
            {
                await request.text();

                return request.headers.get("x-key") === null ? undefined : { id: "someone", claims: {} };
            },

            grants: () => ["auth.write"],
            grantsSupported: ["auth.write"],

            routes: [{
                method: "POST" as const,
                path: "/write",
                describe: "Takes a body behind a permission.",
                requires: ["auth.write"],
                input: z.object({ text: z.string() }),
                output: z.object({ echoed: z.string() }),
                handle: (input: { text: string }) => ({ echoed: input.text }),
            }],
        } as Partial<Definition>);

        const answer = await app.fetch(new Request("http://api.test/write", {
            method: "POST",
            headers: { "content-type": "application/json", "x-key": "abc" },
            body: JSON.stringify({ text: "hello" }),
        }));

        expect(answer.status).toBe(201);
        expect(await answer.json()).toEqual({ echoed: "hello" });
    });
});

describe("the key a request is identified by", () =>
{
    // A caller sending x-session-key used to name their own session: the header
    // beat the cookie, and a request with no cookie was identified by whatever
    // it claimed. HttpOnly means nothing if a header can stand in for it.
    test("comes from the cookie, never from a header the caller sent", () =>
    {
        const forged = new Request("https://example.test/", {
            headers: { cookie: `${settings.name}=real`, [SessionHeaders.key]: "forged" },
        });

        expect(withSessionKey(forged, settings).headers.get(SessionHeaders.key)).toBe("real");
    });

    test("is absent when no cookie carries one, whatever the caller claimed", () =>
    {
        const claimed = new Request("https://example.test/", {
            headers: { [SessionHeaders.key]: "guessed" },
        });

        expect(withSessionKey(claimed, settings).headers.get(SessionHeaders.key)).toBeNull();
    });
});

describe("a request carrying the session cookie and a body", () =>
{
    test("reaches a route that reads its body, where the identify copy once locked the stream", async () =>
    {
        const kernel = createKernel({
            plugins: [definePlugin("auth", {
                version: "1.0.0",
                describe: "Knows who a session belongs to.",
                identifies: (_ctx, request) => request.headers.get(SessionHeaders.key) === "abc123"
                    ? { id: "11111111-1111-4111-8111-111111111111", claims: {} }
                    : undefined,
                routes: [{
                    method: "PATCH",
                    path: "/me",
                    describe: "Renames the caller.",
                    requires: [],
                    input: z.object({ name: z.string() }),
                    output: z.object({ name: z.string() }),
                    handle: (input: { name: string }) => ({ name: input.name }),
                }],
            } as Definition)],
        });

        await kernel.start();

        const app = serve({ kernel, session: settings });

        const response = await app.fetch(new Request("http://localhost/me", {
            method: "PATCH",
            headers: { cookie: "app_session=abc123", "content-type": "application/json" },
            body: JSON.stringify({ name: "Ada" }),
        }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: "Ada" });
    });
});
