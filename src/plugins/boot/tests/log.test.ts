import { describe, expect, test } from "vitest";

import { Log } from "../api";

const lineFor = (about: Readonly<Record<string, unknown>>): Record<string, unknown> =>
{
    return JSON.parse(Log.line("error", "billing failed", about)) as Record<string, unknown>;
};

describe("a log line", () =>
{
    test("keeps its own time, level and message whatever a caller passes", () =>
    {
        const line = lineFor({ at: "1999-01-01T00:00:00.000Z", level: "debug", line: "nothing to see here" });

        expect(line.level).toBe("error");
        expect(line.line).toBe("billing failed");
        expect(line.at).not.toBe("1999-01-01T00:00:00.000Z");
    });

    test("and says why an error happened rather than {}", () =>
    {
        expect(JSON.stringify(lineFor({ cause: new Error("the database is on fire") })))
            .toContain("the database is on fire");
    });

    test("and is still written when what it was given cannot be read", () =>
    {
        const round: Record<string, unknown> = {};

        round.self = round;

        expect(() => Log.line("error", "billing failed", { round, big: 1n })).not.toThrow();
    });

    test("saying so, rather than dropping the line it could not render", () =>
    {
        const hostile = { toJSON: (): never => { throw new Error("no"); } };

        const line = JSON.parse(Log.line("error", "billing failed", { hostile })) as Record<string, unknown>;

        expect(line.about).toBe("unreadable");
        expect(line.line).toBe("billing failed");
    });

    test("writing a loop once, rather than giving the whole line up", () =>
    {
        const round: Record<string, unknown> = {};

        round.self = round;

        const line = JSON.parse(Log.line("error", "billing failed", { round })) as Record<string, unknown>;

        expect(line.round).toEqual({ self: "[circular]" });
    });

    test("and ends in a newline, so two lines are two records", () =>
    {
        expect(Log.line("info", "up").endsWith("\n")).toBe(true);
    });
});

describe("a logger at a level", () =>
{
    test("writes what is at least as loud, and nothing quieter", () =>
    {
        const written: string[] = [];
        const before = process.stdout.write.bind(process.stdout);

        process.stdout.write = ((chunk: string) =>
        {
            written.push(chunk);
            return true;
        }) as typeof process.stdout.write;

        try
        {
            const log = Log.forLevel("warn");

            log.debug("quiet");
            log.info("also quiet");
            log.warn("loud");
            log.error("louder");
        }
        finally
        {
            process.stdout.write = before;
        }

        expect(written).toHaveLength(2);
        expect(written.join("")).toContain("loud");
        expect(written.join("")).not.toContain("quiet");
    });

    test("and a level nobody knows does not silence the rest", () =>
    {
        expect(Log.forLevel("shouting" as never)).toBeDefined();
    });
});
