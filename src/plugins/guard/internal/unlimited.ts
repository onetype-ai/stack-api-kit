import type { Verdict } from "./limit";

/**
 * A budget that counts nothing and allows everything.
 *
 * Every route keeps the numbers it declared: how many attempts are reasonable
 * is a decision, not a setting, and it must read the same in development as in
 * production. What this changes is only whether anything counts them, which is
 * why `start` says so loudly when it is given one.
 */
export function unlimited()
{
    return {
        spend: (): Verdict => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetsIn: 0 }),
        refund: (): void => undefined,
        sweep: (): number => 0,
        size: (): number => 0,
    };
}
