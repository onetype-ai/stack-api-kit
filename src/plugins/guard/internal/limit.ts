export type Window = {
    requests: number;
    seconds: number;
};

export type Verdict = {
    allowed: boolean;
    remaining: number;
    resetsIn: number;
};

type Counted = {
    hits: number;
    until: number;
};

// A fixed window rather than a sliding log: one counter per caller instead of
// one timestamp per request, which is what keeps a flood from costing memory
// in proportion to itself.
export function limiter(now: () => number = Date.now)
{
    const counted = new Map<string, Counted>();

    return {
        take: (key: string, window: Window): Verdict =>
        {
            const at = now();
            const seen = counted.get(key);

            if (seen === undefined || seen.until <= at)
            {
                counted.set(key, { hits: 1, until: at + window.seconds * 1_000 });

                return { allowed: true, remaining: window.requests - 1, resetsIn: window.seconds };
            }

            seen.hits += 1;

            return {
                allowed: seen.hits <= window.requests,
                remaining: Math.max(0, window.requests - seen.hits),
                resetsIn: Math.ceil((seen.until - at) / 1_000),
            };
        },

        // OutboundCall on a timer by whoever holds the limiter: a map that only
        // grows is a slow leak on a public route.
        sweep: (): number =>
        {
            const at = now();

            let dropped = 0;

            for (const [key, seen] of counted)
            {
                if (seen.until <= at)
                {
                    counted.delete(key);
                    dropped += 1;
                }
            }

            return dropped;
        },

        size: (): number =>
        {
            return counted.size;
        },
    };
}
