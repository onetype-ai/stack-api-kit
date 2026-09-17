import type { Logger } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";
import type { Listening } from "./listen";

/** What a stop needs from the process, named so a test hands its own. */
export type Closing = {
    server: Pick<Listening, "close">;
    api: Pick<StartedApp, "stop">;
    log: Logger;
    exit: (code: number) => void;
    stopTimeoutMs?: number;
    drainMs?: number;
};

const wait = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/**
 * Stops once, whatever arrives after.
 *
 * A second signal is ignored rather than cutting the first stop short, which
 * is what loses the requests already in flight. A stop past its timeout exits
 * non-zero rather than hanging forever.
 */
export function closeOnce(closing: Closing): (signal: string) => void
{
    const { server, api, log, exit } = closing;
    const stopTimeoutMs = closing.stopTimeoutMs ?? 10_000;
    const drainMs = closing.drainMs ?? 250;

    let closed = false;

    return (signal: string): void =>
    {
        if (closed)
        {
            return;
        }

        closed = true;

        log.info("stopping", { signal });

        server.close();

        const forced = setTimeout(() =>
        {
            log.error("stop took too long", { signal });
            exit(1);
        }, stopTimeoutMs);

        forced.unref();

        api.stop().then(
            async () =>
            {
                clearTimeout(forced);

                await wait(drainMs);

                exit(0);
            },
            (cause: unknown) =>
            {
                clearTimeout(forced);

                log.error("stop failed", { signal, cause });
                exit(1);
            },
        );
    };
}

/** Closes on `SIGTERM` and `SIGINT`, each reaching the same stop. */
export function closeOnSignal(closing: Closing): void
{
    const close = closeOnce(closing);

    for (const signal of ["SIGTERM", "SIGINT"] as const)
    {
        process.on(signal, () =>
        {
            close(signal);
        });
    }
}
