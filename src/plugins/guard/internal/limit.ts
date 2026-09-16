/** A budget: `requests` allowed per `seconds`, counted in fixed windows rather than a sliding one. */
export type RateLimitWindow = {
    requests: number;
    seconds: number;
};

/** What one `spend` answers; `remaining` floors at 0 and `resetsInSeconds` is the whole window on the call that opened it. */
export type RateLimitResult = {
    allowed: boolean;
    remaining: number;
    resetsInSeconds: number;
};

type WindowCount = {
    hits: number;
    until: number;
};

/** An in-process counter: `spend` allows and counts, `refund` gives one back, `sweep` drops expired keys, `size` reports how many are held; it is per-process, so a second server counts its own. */
export function limiter(now: () => number = Date.now)
{
    const counts = new Map<string, WindowCount>();

    return {
        spend: (key: string, window: RateLimitWindow): RateLimitResult =>
        {
            // seconds: 0 expires the window before the next call reads it, so
            // every request reset the count and the limit allowed everything
            if (!Number.isInteger(window.requests) || window.requests < 1 || !Number.isInteger(window.seconds) || window.seconds < 1)
            {
                throw new RangeError(`A rate limit counts whole requests over whole seconds, both at least 1; received ${String(window.requests)} over ${String(window.seconds)}.`);
            }

            const moment = now();
            const bucket = counts.get(key);

            if (bucket === undefined || bucket.until <= moment)
            {
                counts.set(key, { hits: 1, until: moment + window.seconds * 1_000 });

                return { allowed: true, remaining: window.requests - 1, resetsInSeconds: window.seconds };
            }

            bucket.hits += 1;

            return {
                allowed: bucket.hits <= window.requests,
                remaining: Math.max(0, window.requests - bucket.hits),
                resetsInSeconds: Math.ceil((bucket.until - moment) / 1_000),
            };
        },

        refund: (key: string): void =>
        {
            const bucket = counts.get(key);

            if (bucket !== undefined && bucket.hits > 0)
            {
                bucket.hits -= 1;
            }
        },

        sweep: (): number =>
        {
            const moment = now();

            let dropped = 0;

            for (const [key, bucket] of counts)
            {
                if (bucket.until <= moment)
                {
                    counts.delete(key);
                    dropped += 1;
                }
            }

            return dropped;
        },

        size: (): number =>
        {
            return counts.size;
        },
    };
}
