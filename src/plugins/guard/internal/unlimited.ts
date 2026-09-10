import type { RateLimitResult } from "./limit";

/** A budget that counts nothing and allows everything. */
export function unlimited()
{
    return {
        spend: (): RateLimitResult => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetsIn: 0 }),
        refund: (): void => undefined,
        sweep: (): number => 0,
        size: (): number => 0,
    };
}
