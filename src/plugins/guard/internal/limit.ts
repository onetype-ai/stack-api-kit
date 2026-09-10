export type RateLimitWindow = {
    requests: number;
    seconds: number;
};

export type RateLimitResult = {
    allowed: boolean;
    remaining: number;
    resetsIn: number;
};

type WindowCount = {
    hits: number;
    until: number;
};

export function limiter(now: () => number = Date.now)
{
    const counts = new Map<string, WindowCount>();

    return {
        spend: (key: string, window: RateLimitWindow): RateLimitResult =>
        {
            const moment = now();
            const bucket = counts.get(key);

            if (bucket === undefined || bucket.until <= moment)
            {
                counts.set(key, { hits: 1, until: moment + window.seconds * 1_000 });

                return { allowed: true, remaining: window.requests - 1, resetsIn: window.seconds };
            }

            bucket.hits += 1;

            return {
                allowed: bucket.hits <= window.requests,
                remaining: Math.max(0, window.requests - bucket.hits),
                resetsIn: Math.ceil((bucket.until - moment) / 1_000),
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
