import { afterEach, describe, expect, test } from "vitest";

import { Env } from "../api";

const before = process.env.PROBE;

afterEach(() =>
{
    if (before === undefined)
    {
        delete process.env.PROBE;
        return;
    }

    process.env.PROBE = before;
});

describe("a value that is set and empty", () =>
{
    test("is refused, rather than read as the fallback an unset one takes", () =>
    {
        process.env.PROBE = "";

        expect(() => Env.text("PROBE", "fallback")).toThrow(/PROBE/);
    });

    test("while an unset one takes the fallback, so absent and blank never agree", () =>
    {
        delete process.env.PROBE;

        expect(Env.text("PROBE", "fallback")).toBe("fallback");
    });

    test("and a required one that is unset names itself", () =>
    {
        delete process.env.PROBE;

        expect(() => Env.required("PROBE")).toThrow(/PROBE/);
    });
});

describe("a number read from the environment", () =>
{
    test("is refused when it is only a space, rather than read as zero", () =>
    {
        process.env.PROBE = "  ";

        expect(() => Env.number("PROBE", 1)).toThrow(/PROBE/);
    });

    test("and refused when it is not a whole number at all", () =>
    {
        for (const bad of ["abc", "-1", "1.5", "1e999"])
        {
            process.env.PROBE = bad;

            expect(() => Env.number("PROBE", 1)).toThrow(/PROBE/);
        }
    });

    test("but read when it is one", () =>
    {
        process.env.PROBE = "3000";

        expect(Env.number("PROBE", 1)).toBe(3000);
    });
});

describe("a number that is legal to type", () =>
{
    test("is refused when it is not legal to mean", () =>
    {
        process.env.PROBE = "0";

        expect(() => Env.number("PROBE", 1, 1)).toThrow(/PROBE/);
        expect(() => Env.number("PROBE", 1, 1, 65_535)).toThrow(/PROBE/);
    });

    test("and refused when it is past what it may be", () =>
    {
        process.env.PROBE = "70000";

        expect(() => Env.number("PROBE", 1, 1, 65_535)).toThrow(/PROBE/);
    });

    test("but taken at either end of what it may be", () =>
    {
        process.env.PROBE = "1";

        expect(Env.number("PROBE", 3000, 1, 65_535)).toBe(1);

        process.env.PROBE = "65535";

        expect(Env.number("PROBE", 3000, 1, 65_535)).toBe(65_535);
    });
});

describe("a list read from the environment", () =>
{
    test("means nothing allowed when it is set and empty", () =>
    {
        process.env.PROBE = "";

        expect(Env.list("PROBE")).toEqual([]);
    });

    test("and drops the gaps a trailing comma leaves", () =>
    {
        process.env.PROBE = "a, b, ,";

        expect(Env.list("PROBE")).toEqual(["a", "b"]);
    });
});

describe("a flag read from the environment", () =>
{
    test("takes the two words it knows", () =>
    {
        process.env.PROBE = "true";

        expect(Env.flag("PROBE", false)).toBe(true);

        process.env.PROBE = "false";

        expect(Env.flag("PROBE", true)).toBe(false);
    });

    test("and refuses anything else rather than guessing what it meant", () =>
    {
        for (const bad of ["1", "yes", "TRUE", "on"])
        {
            process.env.PROBE = bad;

            expect(() => Env.flag("PROBE", false)).toThrow(/PROBE/);
        }
    });
});

describe("one of a list of allowed words", () =>
{
    test("is taken when it is on the list", () =>
    {
        process.env.PROBE = "warn";

        expect(Env.oneOf("PROBE", ["debug", "info", "warn"], "info")).toBe("warn");
    });

    test("and refused when it is not, naming what was allowed", () =>
    {
        process.env.PROBE = "shouting";

        expect(() => Env.oneOf("PROBE", ["debug", "info", "warn"], "info")).toThrow(/PROBE/);
    });
});

describe("the same rules over a value read somewhere else", () =>
{
    test("refuse what the environment ones refuse, so a bundler's value is held to the same line", () =>
    {
        expect(() => Env.rules.number("VITE_PORT", "1.5", 1)).toThrow(/VITE_PORT/);
        expect(() => Env.rules.flag("VITE_ON", "yes", false)).toThrow(/VITE_ON/);
        expect(() => Env.rules.text("VITE_URL", "")).toThrow(/VITE_URL/);
    });

    test("and take what they take, without reading the environment at all", () =>
    {
        delete process.env.PROBE;

        expect(Env.rules.number("PROBE", "3000", 1)).toBe(3000);
        expect(Env.rules.list("a, b, ,")).toEqual(["a", "b"]);
        expect(Env.rules.text("PROBE", undefined, "fallback")).toBe("fallback");
    });
});
