/** A clock a test moves by hand, handed to a test kernel as `now`: tomorrow is one call away, and nothing waits. */
export type TestClock = {
    now: () => number;
    advance: (ms: number) => number;
    set: (at: number) => number;
};

/** A clock starting at `at` (the current moment when left out) that moves only when told. */
export function testClock(at: number = Date.now()): TestClock
{
    let current = at;

    return {
        now: () => current,

        advance: (ms: number): number =>
        {
            if (!Number.isFinite(ms) || ms < 0)
            {
                throw new TypeError(`testClock: advance takes a number of milliseconds of 0 or more, and was given ${String(ms)}. A clock that runs backwards is a different test.`);
            }

            current += ms;

            return current;
        },

        set: (next: number): number =>
        {
            current = next;

            return current;
        },
    };
}
