import { describe, expect, test, vi } from "vitest";

import { freshFailures, watch } from "../api";

import type { ListenerFailure, Logger } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

const failure = (at: number, plugin = "billing", event = "invoices.issued"): ListenerFailure =>
    ({ event, plugin, error: new Error("nope"), at }) as ListenerFailure;

describe("what a watch says about listeners that failed", () =>
{
    test("is everything it has not read before", () =>
    {
        const { fresh, read } = freshFailures([failure(10), failure(20)], 0);

        expect(fresh).toHaveLength(2);
        expect(read).toBe(2);
    });

    test("and never the same one twice", () =>
    {
        const failures = [failure(10), failure(20)];

        expect(freshFailures(failures, freshFailures(failures, 0).read).fresh).toEqual([]);
    });

    test("including one that failed in the same millisecond as the last", () =>
    {
        const { read } = freshFailures([failure(10)], 0);
        const { fresh } = freshFailures([failure(10), failure(10)], read);

        expect(fresh).toHaveLength(1);
    });

    test("but does notice one that fails again after that", () =>
    {
        const { read } = freshFailures([failure(10)], 0);
        const { fresh } = freshFailures([failure(10), failure(30)], read);

        expect(fresh).toHaveLength(1);
        expect(fresh[0]?.at).toBe(30);
    });

    test("and says nothing at all when nothing broke", () =>
    {
        expect(freshFailures([], 0)).toEqual({ fresh: [], read: 0 });
    });
});

function watching(failures: readonly ListenerFailure[][])
{
    const lines: { line: string; about?: Readonly<Record<string, unknown>> }[] = [];
    let round = 0;

    const log = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (line: string, about?: Readonly<Record<string, unknown>>) =>
        {
            lines.push({ line, ...(about === undefined ? {} : { about }) });
        },
    } as Logger;

    const api = {
        kernel: { events: { failures: () => failures[round] ?? [] } },
    } as unknown as StartedApp;

    return { api, log, lines, turn: () => { round += 1; } };
}

describe("a watch on a timer", () =>
{
    test("says nothing while nothing has broken", () =>
    {
        vi.useFakeTimers();

        try
        {
            const { api, log, lines } = watching([[]]);

            watch(api, log, 1000);
            vi.advanceTimersByTime(3000);

            expect(lines).toEqual([]);
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    test("and reports a failure once, however many times it looks after", () =>
    {
        vi.useFakeTimers();

        try
        {
            const { api, log, lines } = watching([[failure(10)]]);

            watch(api, log, 1000);
            vi.advanceTimersByTime(3000);

            expect(lines).toHaveLength(1);
            expect(lines[0]?.line).toBe("listeners failed");
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    test("and starts over when the list shrank, rather than reporting nothing forever", () =>
    {
        vi.useFakeTimers();

        try
        {
            const { api, log, lines, turn } = watching([[failure(10), failure(20)], [failure(30)]]);

            watch(api, log, 1000);
            vi.advanceTimersByTime(1000);

            expect(lines).toHaveLength(1);

            turn();
            vi.advanceTimersByTime(1000);

            expect(lines).toHaveLength(2);
        }
        finally
        {
            vi.useRealTimers();
        }
    });
});
