import type { ListenerFailure, Logger } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

/** What a watch has not reported yet, and how far it has now read. */
export type FreshFailures = {
    fresh: readonly ListenerFailure[];
    read: number;
};

/** Everything a watch has not read before, and never the same failure twice. */
export function freshFailures(failures: readonly ListenerFailure[], readCount: number): FreshFailures
{
    return { fresh: failures.slice(readCount), read: failures.length };
}

const whyOf = (failure: ListenerFailure): string =>
    failure.error instanceof Error ? failure.error.message : String(failure.error);

/**
 * Reports listeners that failed, on a timer, each one once.
 *
 * A list shorter than what was read means the kernel restarted its own, so
 * the count starts over rather than reporting nothing forever.
 */
export function watch(api: StartedApp, log: Logger, everyMs: number): NodeJS.Timeout
{
    let readCount = 0;

    const timer = setInterval(() =>
    {
        const failures = api.kernel.events.failures();

        if (failures.length < readCount)
        {
            readCount = 0;
        }

        const { fresh, read } = freshFailures(failures, readCount);

        readCount = read;

        if (fresh.length > 0)
        {
            log.error("listeners failed", {
                count: fresh.length,
                events: fresh.map((failure) => `${failure.plugin}:${failure.event}`),
                why: [...new Set(fresh.map(whyOf))].slice(0, 5),
            });
        }
    }, everyMs);

    timer.unref();

    return timer;
}
