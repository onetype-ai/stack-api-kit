import { describe, expect, test } from "vitest";

import { measure } from "../api";

const bytes = measure("bytes");
const gigabytes = measure("gigabytes");

type Bytes = ReturnType<typeof bytes>;
type Gigabytes = ReturnType<typeof gigabytes>;

describe("a measured number", () =>
{
    test("is the number it was given", () =>
    {
        expect(bytes(1000)).toBe(1000);
        expect(bytes(0)).toBe(0);
        expect(bytes(-1)).toBe(-1);
    });

    test("compares, interpolates and divides like one", () =>
    {
        expect(bytes(2000) > bytes(1000)).toBe(true);
        expect(`${bytes(1000)}`).toBe("1000");
        expect(bytes(1000) / 2).toBe(500);
    });

    test("and answers the same value whatever unit it was named", () =>
    {
        expect(gigabytes(5)).toBe(bytes(5));
    });
});

describe("the mistake it exists to stop", () =>
{
    // One project counted storage in bytes, read a quota in gigabytes, and
    // refused every caller on their first file. Written out, it is this.
    const used = (): Bytes => bytes(1000);
    const mayHaveAnother = (many: Gigabytes): boolean => many < gigabytes(5);

    test("does not compile, which is the whole point", () =>
    {
        // @ts-expect-error bytes are not gigabytes
        mayHaveAnother(used());

        expect(mayHaveAnother(gigabytes(1))).toBe(true);
    });

    test("and neither does a bare number, which says nothing at all", () =>
    {
        // @ts-expect-error a number carries no unit
        mayHaveAnother(5);

        expect(mayHaveAnother(gigabytes(5))).toBe(false);
    });

    test("converting says so out loud", () =>
    {
        const perGigabyte = 1_000_000_000;
        const asGigabytes = (many: Bytes): Gigabytes => gigabytes(Math.ceil(many / perGigabyte));

        expect(mayHaveAnother(asGigabytes(used()))).toBe(true);
        expect(asGigabytes(bytes(6_000_000_000))).toBe(6);
    });
});
