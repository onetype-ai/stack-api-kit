import { describe, expect, test, vi } from "vitest";

import { closeOnce } from "../api";

import type { Logger } from "../../kernel/api";

function stopping(stop: () => Promise<void>)
{
    const closed: string[] = [];
    const exits: number[] = [];
    const errors: string[] = [];

    const log = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (line: string) =>
        {
            errors.push(line);
        },
    } as Logger;

    const close = closeOnce({
        server: { close: () => { closed.push("server"); } } as never,
        api: { stop } as never,
        log,
        exit: (code) => { exits.push(code); },
        stopTimeoutMs: 1000,
        drainMs: 10,
    });

    return { close, closed, exits, errors };
}

describe("a stop", () =>
{
    test("closes the server and exits zero once the kernel stopped", async () =>
    {
        const { close, closed, exits } = stopping(() => Promise.resolve());

        close("SIGTERM");

        await vi.waitFor(() => { expect(exits).toEqual([0]); });

        expect(closed).toEqual(["server"]);
    });

    test("and happens once, so a second signal never cuts the first short", async () =>
    {
        const { close, closed, exits } = stopping(() => Promise.resolve());

        close("SIGTERM");
        close("SIGINT");
        close("SIGTERM");

        await vi.waitFor(() => { expect(exits).toEqual([0]); });

        expect(closed).toEqual(["server"]);
    });

    test("and exits non-zero when the kernel refused to stop, saying so", async () =>
    {
        const { close, exits, errors } = stopping(() => Promise.reject(new Error("nope")));

        close("SIGTERM");

        await vi.waitFor(() => { expect(exits).toEqual([1]); });

        expect(errors).toContain("stop failed");
    });

    test("and exits non-zero when stopping took longer than it may", async () =>
    {
        vi.useFakeTimers();

        try
        {
            const { close, exits, errors } = stopping(() => new Promise<void>(() => {}));

            close("SIGTERM");
            vi.advanceTimersByTime(1000);

            expect(exits).toEqual([1]);
            expect(errors).toContain("stop took too long");
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    test("and a clean stop leaves no timer behind to fire after it", async () =>
    {
        vi.useFakeTimers();

        try
        {
            const { close, exits } = stopping(() => Promise.resolve());

            close("SIGTERM");

            await vi.advanceTimersByTimeAsync(10);
            await vi.advanceTimersByTimeAsync(5000);

            expect(exits).toEqual([0]);
        }
        finally
        {
            vi.useRealTimers();
        }
    });
});
