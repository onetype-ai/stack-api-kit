export type Window = {
    requests: number;
    seconds: number;
};

export type Verdict = {
    allowed: boolean;
    remaining: number;
    resetsIn: number;
};

type Bucket = {
    hits: number;
    until: number;
};

// A fixed window rather than a sliding log: one counter per caller instead of
// one timestamp per request, which is what keeps a flood from costing memory
// in proportion to itself.
export function limiter(now: () => number = Date.now)
{
    const buckets = new Map<string, Bucket>();

    return {
        take: (key: string, window: Window): Verdict =>
        {
            const at = now();
            const bucket = buckets.get(key);

            if (bucket === undefined || bucket.until <= at)
            {
                buckets.set(key, { hits: 1, until: at + window.seconds * 1_000 });

                return { allowed: true, remaining: window.requests - 1, resetsIn: window.seconds };
            }

            bucket.hits += 1;

            return {
                allowed: bucket.hits <= window.requests,
                remaining: Math.max(0, window.requests - bucket.hits),
                resetsIn: Math.ceil((bucket.until - at) / 1_000),
            };
        },

        // Called on a timer by whoever holds the limiter: a map that only
        // grows is a slow leak on a public route.
        sweep: (): number =>
        {
            const at = now();

            let dropped = 0;

            for (const [key, bucket] of buckets)
            {
                if (bucket.until <= at)
                {
                    buckets.delete(key);
                    dropped += 1;
                }
            }

            return dropped;
        },

        size: (): number =>
        {
            return buckets.size;
        },
    };
}
