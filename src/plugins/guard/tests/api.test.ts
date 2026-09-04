import { describe, expect, test } from "vitest";

import { limiter, same } from "../api";

describe("limiting", () =>
{
    test("allows up to the count and refuses past it", () =>
    {
        const limit = limiter();
        const window = { requests: 3, seconds: 60 };

        const verdicts = [1, 2, 3, 4].map(() => limit.take("u1", window));

        expect(verdicts.map((verdict) => verdict.allowed)).toEqual([true, true, true, false]);
    });

    test("counts each caller apart from the others", () =>
    {
        const limit = limiter();
        const window = { requests: 1, seconds: 60 };

        limit.take("u1", window);

        expect(limit.take("u2", window).allowed).toBe(true);
    });

    test("starts a new window once the old one passed", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);
        const window = { requests: 1, seconds: 60 };

        limit.take("u1", window);
        clock = 61_000;

        expect(limit.take("u1", window).allowed).toBe(true);
    });

    test("says how long until the window resets", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);

        limit.take("u1", { requests: 1, seconds: 60 });
        clock = 30_000;

        expect(limit.take("u1", { requests: 1, seconds: 60 }).resetsIn).toBe(30);
    });

    test("drops windows that have passed rather than growing forever", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);

        limit.take("u1", { requests: 1, seconds: 60 });
        limit.take("u2", { requests: 1, seconds: 60 });

        expect(limit.size()).toBe(2);

        clock = 61_000;

        expect(limit.sweep()).toBe(2);
        expect(limit.size()).toBe(0);
    });
});

describe("comparing", () =>
{
    test("answers true only for the same string", () =>
    {
        expect(same("token-abc", "token-abc")).toBe(true);
        expect(same("token-abc", "token-abd")).toBe(false);
    });

    test("answers false on a length difference rather than throwing", () =>
    {
        expect(same("short", "much longer secret")).toBe(false);
        expect(same("", "x")).toBe(false);
    });

    test("compares by bytes, so two different strings never match", () =>
    {
        expect(same("é", "e")).toBe(false);
    });
});
