/** Runs work one at a time. */
export function queue()
{
    let last: Promise<unknown> = Promise.resolve();

    return {
        run: <Result,>(work: () => Promise<Result>): Promise<Result> =>
        {
            const running = last.then(work, work);

            last = running.catch(() => undefined);

            return running;
        },
    };
}
