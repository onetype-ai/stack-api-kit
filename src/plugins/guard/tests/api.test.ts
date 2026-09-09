import { describe, expect, test } from "vitest";

import { limiter, equalsInConstantTime } from "../api";

describe("limiting", () =>
{
    test("allows up to the count and refuses past it", () =>
    {
        const limit = limiter();
        const window = { requests: 3, seconds: 60 };

        const verdicts = [1, 2, 3, 4].map(() => limit.spend("u1", window));

        expect(verdicts.map((verdict) => verdict.allowed)).toEqual([true, true, true, false]);
    });

    test("counts each identity apart from the others", () =>
    {
        const limit = limiter();
        const window = { requests: 1, seconds: 60 };

        limit.spend("u1", window);

        expect(limit.spend("u2", window).allowed).toBe(true);
    });

    test("starts a new window once the old one passed", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);
        const window = { requests: 1, seconds: 60 };

        limit.spend("u1", window);
        clock = 61_000;

        expect(limit.spend("u1", window).allowed).toBe(true);
    });

    test("says how long until the window resets", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);

        limit.spend("u1", { requests: 1, seconds: 60 });
        clock = 30_000;

        expect(limit.spend("u1", { requests: 1, seconds: 60 }).resetsIn).toBe(30);
    });

    test("drops windows that have passed rather than growing forever", () =>
    {
        let clock = 0;
        const limit = limiter(() => clock);

        limit.spend("u1", { requests: 1, seconds: 60 });
        limit.spend("u2", { requests: 1, seconds: 60 });

        expect(limit.size()).toBe(2);

        clock = 61_000;

        expect(limit.sweep()).toBe(2);
        expect(limit.size()).toBe(0);
    });
});

describe("giving a spend back", () =>
{
    test("frees one attempt, and no more than were taken", () =>
    {
        const limit = limiter();
        const window = { requests: 2, seconds: 60 };

        limit.spend("u1", window);

        // One back for the one that was spent, so the window is as it was.
        limit.refund("u1");

        expect([limit.spend("u1", window).allowed, limit.spend("u1", window).allowed]).toEqual([true, true]);

        // More refunds than spends would bank credit against the window,
        // which is a caller earning attempts by succeeding.
        for (let turn = 0; turn < 6; turn += 1)
        {
            limit.refund("u1");
        }

        expect([limit.spend("u1", window).allowed, limit.spend("u1", window).allowed, limit.spend("u1", window).allowed])
            .toEqual([true, true, false]);
    });

    test("does nothing for a key nothing ever spent", () =>
    {
        const limit = limiter();

        expect(() => { limit.refund("never-seen"); }).not.toThrow();
        expect(limit.size()).toBe(0);
    });
});

describe("comparing", () =>
{
    test("answers true only for the equalsInConstantTime string", () =>
    {
        expect(equalsInConstantTime("token-abc", "token-abc")).toBe(true);
        expect(equalsInConstantTime("token-abc", "token-abd")).toBe(false);
    });

    test("answers false on a length difference rather than throwing", () =>
    {
        expect(equalsInConstantTime("short", "much longer secret")).toBe(false);
        expect(equalsInConstantTime("", "x")).toBe(false);
    });

    test("compares by bytes, so two different strings never match", () =>
    {
        expect(equalsInConstantTime("é", "e")).toBe(false);
    });
});
