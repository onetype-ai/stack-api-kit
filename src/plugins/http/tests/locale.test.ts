import { expect, test } from "vitest";

import { Locale } from "../api";

// the case table both kits run, from the shared locale contract
test.each([
    ["de-AT,de;q=0.9,en;q=0.5", ["en", "de"], "en", undefined, "de"],
    ["fr", ["en", "de"], "en", undefined, "en"],
    ["en-GB;q=0.8,de;q=0.9", ["en", "de"], "en", undefined, "de"],
    [["pt-BR"], ["en", "pt-PT"], "en", undefined, "pt-PT"],
    ["de", ["en", "de"], "en", "en", "en"],
    ["*;q=1,de;q=0", ["en", "de"], "en", undefined, "en"],
    ["DE-at, en", ["en", "de-DE", "de-AT"], "en", undefined, "de-AT"],
    ["de", ["en", "de"], "en", "fr", "de"],
])("negotiates %j over %j", (accepted, supported, fallback, chosen, expected) =>
{
    expect(Locale.negotiate(accepted, supported, fallback, chosen)).toBe(expected);
});

test("refuses a fallback it does not support", () =>
{
    expect(() => Locale.negotiate("de", ["en", "de"], "fr")).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
