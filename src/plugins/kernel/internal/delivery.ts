import type { Outbox } from "./store";

/** How long a written row waits before another process may deliver it, and how long a lease holds, when the outbox names nothing. */
export const OUTBOX_LEASE_MS = 60_000;

/** How long an event waits before its next delivery, after `attempts` failed ones: 2^n seconds, five minutes at most. */
export function retryDelayMs(attempts: number): number
{
    return Math.min(2 ** attempts, 300) * 1000;
}

/**
 * Keeps, as it finishes, that one listener heard an event. If that cannot be written (the store closed under a late
 * listener), the event is only delivered to it again, which a listener already allows for.
 */
export function keepHeard(outbox: Outbox | undefined, id: string, listener: string, failed: (cause: unknown) => void): void
{
    void Promise.resolve().then(() => outbox?.markHeard?.(id, listener)).catch((cause: unknown) =>
    {
        failed(cause);
    });
}

/** Renews a row's lease every third of it until the delivery settles, so a slow listener is not handed the event twice; answers the timer to clear. */
export function holdWhileDelivering(outbox: Outbox | undefined, id: string, now: () => number): ReturnType<typeof setInterval> | undefined
{
    if (outbox?.renew === undefined)
    {
        return undefined;
    }

    const timer = setInterval(() =>
    {
        void Promise.resolve().then(() => outbox.renew?.(id, now())).catch(() =>
        {
            clearInterval(timer);
        });
    }, Math.floor((outbox.leaseMs ?? OUTBOX_LEASE_MS) / 3));

    timer.unref?.();

    return timer;
}
